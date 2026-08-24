import { decodeBase64, encodeBase64 } from "./Base64";
import { canonicalStringify, SyncOperation } from "./OperationReducer";

const OPERATION_FORMAT_VERSION = 1;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 4096;
const MAX_LABEL_LENGTH = 512;
const MAX_PARENT_COUNT = 256;
const MAX_ORDER_IDS = 10000;
const AES_KEY_BYTES = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GCM_NONCE_BYTES = 12;

export type SyncEncryptionMode = "none" | "aes-256-gcm";

export interface Argon2idKdfConfig {
  name: "argon2id";
  salt: string;
  time: number;
  memoryKiB: number;
  parallelism: number;
  hashLength: number;
}

export interface WrappedDataKey {
  nonce: string;
  ciphertext: string;
}

export interface RepositoryEncryptionHeader {
  protocolVersion: 1;
  repositoryId: string;
  mode: "aes-256-gcm";
  kdf: Argon2idKdfConfig;
}

interface EncryptedOperationEnvelope {
  formatVersion: 1;
  repositoryId: string;
  opId: string;
  encrypted: true;
  nonce: string;
  ciphertext: string;
}

interface PlainOperationEnvelope {
  formatVersion: 1;
  repositoryId: string;
  opId: string;
  encrypted: false;
  plaintextHash: string;
  operation: SyncOperation;
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string
) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range`);
  }
}

function requireAesKey(value: Uint8Array, name: string) {
  if (value.byteLength !== AES_KEY_BYTES) {
    throw new Error(`${name} must contain 32 bytes`);
  }
  return value;
}

function requireNonce(value?: Uint8Array) {
  const nonce =
    value || crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  if (nonce.byteLength !== GCM_NONCE_BYTES) {
    throw new Error("AES-GCM nonce must contain 12 bytes");
  }
  return nonce;
}

function importAesKey(value: Uint8Array, usages: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    requireAesKey(value, "AES key"),
    { name: "AES-GCM" },
    false,
    usages
  );
}

function encode(value: string) {
  return new TextEncoder().encode(value);
}

function decode(value: ArrayBuffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

async function sha256(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode(value))
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function assertUuidV4(value: string, name: string) {
  if (!UUID_V4.test(value)) {
    throw new Error(`${name} must be a lowercase UUIDv4`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  name: string
) {
  const extraKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key)
  );
  if (extraKeys.length > 0) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function assertOptionalString(
  value: unknown,
  maximumLength: number,
  name: string
) {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length > maximumLength)
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function assertOtpPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("OTP payload is invalid");
  }
  const value = payload as Record<string, unknown>;
  assertAllowedKeys(
    value,
    [
      "type",
      "secret",
      "issuer",
      "account",
      "counter",
      "period",
      "digits",
      "algorithm",
      "pinned",
    ],
    "OTP payload"
  );
  if (
    typeof value.type !== "string" ||
    !["totp", "hotp", "battle", "steam", "hex", "hhex"].includes(value.type) ||
    typeof value.secret !== "string" ||
    value.secret.length === 0 ||
    value.secret.length > MAX_SECRET_LENGTH
  ) {
    throw new Error("OTP payload type or secret is invalid");
  }
  assertOptionalString(value.issuer, MAX_LABEL_LENGTH, "OTP issuer");
  assertOptionalString(value.account, MAX_LABEL_LENGTH, "OTP account");
  if (
    value.counter !== undefined &&
    (!Number.isSafeInteger(value.counter) || Number(value.counter) < 0)
  ) {
    throw new Error("OTP counter is invalid");
  }
  if (
    value.period !== undefined &&
    (!Number.isSafeInteger(value.period) ||
      Number(value.period) < 1 ||
      Number(value.period) > 86400)
  ) {
    throw new Error("OTP period is invalid");
  }
  if (
    value.digits !== undefined &&
    (!Number.isSafeInteger(value.digits) ||
      Number(value.digits) < 1 ||
      Number(value.digits) > 10)
  ) {
    throw new Error("OTP digits are invalid");
  }
  if (
    value.algorithm !== undefined &&
    (typeof value.algorithm !== "string" ||
      ![
        "SHA1",
        "SHA256",
        "SHA512",
        "GOST3411_2012_256",
        "GOST3411_2012_512",
      ].includes(value.algorithm))
  ) {
    throw new Error("OTP algorithm is invalid");
  }
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") {
    throw new Error("OTP pinned flag is invalid");
  }
}

function assertOrderPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Order payload is invalid");
  }
  const value = payload as Record<string, unknown>;
  assertAllowedKeys(value, ["ids"], "Order payload");
  if (
    !Array.isArray(value.ids) ||
    value.ids.length > MAX_ORDER_IDS ||
    !value.ids.every((id) => typeof id === "string" && UUID_V4.test(id)) ||
    new Set(value.ids).size !== value.ids.length
  ) {
    throw new Error("Order ids are invalid");
  }
}

function assertOperationPayload(operation: SyncOperation) {
  let payload = operation.payload;
  if (operation.kind === "delete") {
    if (payload !== null) {
      throw new Error("Delete operation payload must be null");
    }
    return;
  }
  if (operation.kind === "resolve") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Resolve operation payload is invalid");
    }
    const resolution = payload as Record<string, unknown>;
    if (resolution.resolution === "delete") {
      assertAllowedKeys(resolution, ["resolution"], "Resolve payload");
      return;
    }
    if (resolution.resolution !== "upsert") {
      throw new Error("Resolve operation choice is invalid");
    }
    assertAllowedKeys(resolution, ["resolution", "entry"], "Resolve payload");
    payload = resolution.entry;
  }
  if (operation.entityType === "otp") {
    assertOtpPayload(payload);
  } else {
    assertOrderPayload(payload);
  }
}

async function assertOperation(operation: SyncOperation) {
  if (operation && typeof operation === "object" && !Array.isArray(operation)) {
    assertAllowedKeys(
      (operation as unknown) as Record<string, unknown>,
      [
        "formatVersion",
        "repositoryId",
        "opId",
        "deviceId",
        "entityType",
        "entityId",
        "kind",
        "parents",
        "createdAt",
        "contentHash",
        "payload",
      ],
      "Operation"
    );
  }
  if (
    !operation ||
    typeof operation !== "object" ||
    typeof operation.opId !== "string" ||
    typeof operation.repositoryId !== "string" ||
    operation.formatVersion !== 1 ||
    typeof operation.deviceId !== "string" ||
    (operation.entityType !== "otp" && operation.entityType !== "order") ||
    typeof operation.entityId !== "string" ||
    (operation.kind !== "upsert" &&
      operation.kind !== "delete" &&
      operation.kind !== "resolve") ||
    !Array.isArray(operation.parents) ||
    operation.parents.some((parent) => typeof parent !== "string") ||
    !Number.isSafeInteger(operation.createdAt) ||
    operation.createdAt < 0 ||
    typeof operation.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(operation.contentHash)
  ) {
    throw new Error("Operation schema is invalid");
  }
  assertUuidV4(operation.opId, "Operation id");
  assertUuidV4(operation.repositoryId, "Repository id");
  assertUuidV4(operation.deviceId, "Device id");
  if (operation.entityType === "otp") {
    assertUuidV4(operation.entityId, "OTP entity id");
  } else if (operation.entityId !== "global-order") {
    throw new Error("Order entity id must be global-order");
  }
  if (operation.parents.length > MAX_PARENT_COUNT) {
    throw new Error("Operation has too many parents");
  }
  for (const parent of operation.parents) {
    assertUuidV4(parent, "Parent operation id");
  }
  if (new Set(operation.parents).size !== operation.parents.length) {
    throw new Error("Operation parents must be unique");
  }
  const canonicalPayload = canonicalStringify(operation.payload);
  if (encode(canonicalPayload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("Operation payload exceeds the size limit");
  }
  assertOperationPayload(operation);
  const expectedHash = await sha256(canonicalPayload);
  if (operation.contentHash !== expectedHash) {
    throw new Error("Operation content hash does not match its payload");
  }
}

function operationAad(repositoryId: string, opId: string) {
  return encode(
    canonicalStringify({
      formatVersion: OPERATION_FORMAT_VERSION,
      repositoryId,
      opId,
    })
  );
}

function wrappedKeyAad(header: RepositoryEncryptionHeader) {
  validateKdfConfig(header.kdf);
  if (
    header.protocolVersion !== 1 ||
    header.mode !== "aes-256-gcm" ||
    !header.repositoryId
  ) {
    throw new Error("Repository encryption header is invalid");
  }
  return encode(
    canonicalStringify({
      protocolVersion: header.protocolVersion,
      repositoryId: header.repositoryId,
      mode: header.mode,
      kdf: header.kdf,
    })
  );
}

function serializeEnvelope(envelope: unknown) {
  const serialized = canonicalStringify(envelope);
  if (encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error("Operation envelope exceeds the size limit");
  }
  return serialized;
}

function parseEnvelope(serialized: string) {
  if (encode(serialized).byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error("Operation envelope exceeds the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Operation envelope is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Operation envelope schema is invalid");
  }
  if (canonicalStringify(parsed) !== serialized) {
    throw new Error("Operation envelope is not canonically serialized");
  }
  return parsed as Record<string, unknown>;
}

export function validateKdfConfig(config: Argon2idKdfConfig) {
  if (!config || config.name !== "argon2id") {
    throw new Error("Only Argon2id is supported");
  }
  const salt = decodeBase64(config.salt, "Argon2 salt");
  if (salt.byteLength < 16 || salt.byteLength > 64) {
    throw new Error("Argon2 salt must contain between 16 and 64 bytes");
  }
  assertIntegerInRange(config.time, 2, 5, "Argon2 time");
  assertIntegerInRange(config.memoryKiB, 19456, 131072, "Argon2 memory");
  assertIntegerInRange(config.parallelism, 1, 2, "Argon2 parallelism");
  if (config.hashLength !== 32) {
    throw new Error("Argon2 hash length must be 32 bytes");
  }
  return config;
}

export async function createOperation(
  operation: Omit<SyncOperation, "contentHash">
): Promise<SyncOperation> {
  const result: SyncOperation = {
    ...operation,
    contentHash: await sha256(canonicalStringify(operation.payload)),
  };
  await assertOperation(result);
  return result;
}

export async function createOperationEnvelope(
  operation: SyncOperation,
  mode: SyncEncryptionMode,
  dataKey?: Uint8Array,
  nonceValue?: Uint8Array
) {
  await assertOperation(operation);

  if (mode === "none") {
    const envelope: PlainOperationEnvelope = {
      formatVersion: OPERATION_FORMAT_VERSION,
      repositoryId: operation.repositoryId,
      opId: operation.opId,
      encrypted: false,
      plaintextHash: await sha256(canonicalStringify(operation)),
      operation,
    };
    return serializeEnvelope(envelope);
  }

  if (mode !== "aes-256-gcm" || !dataKey) {
    throw new Error("Repository data key is required for encrypted sync");
  }
  const nonce = requireNonce(nonceValue);
  const key = await importAesKey(dataKey, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: operationAad(operation.repositoryId, operation.opId),
      },
      key,
      encode(canonicalStringify(operation))
    )
  );
  const envelope: EncryptedOperationEnvelope = {
    formatVersion: OPERATION_FORMAT_VERSION,
    repositoryId: operation.repositoryId,
    opId: operation.opId,
    encrypted: true,
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
  return serializeEnvelope(envelope);
}

export async function openOperationEnvelope(
  serialized: string,
  expectedMode: SyncEncryptionMode,
  dataKey?: Uint8Array
): Promise<SyncOperation> {
  const envelope = parseEnvelope(serialized);
  if (
    envelope.formatVersion !== OPERATION_FORMAT_VERSION ||
    typeof envelope.repositoryId !== "string" ||
    typeof envelope.opId !== "string" ||
    typeof envelope.encrypted !== "boolean"
  ) {
    throw new Error("Operation envelope schema is invalid");
  }

  if (
    (expectedMode === "aes-256-gcm" && !envelope.encrypted) ||
    (expectedMode === "none" && envelope.encrypted)
  ) {
    throw new Error("Operation envelope encryption mode does not match config");
  }

  let operation: SyncOperation;
  if (envelope.encrypted) {
    assertAllowedKeys(
      envelope,
      [
        "formatVersion",
        "repositoryId",
        "opId",
        "encrypted",
        "nonce",
        "ciphertext",
      ],
      "Encrypted operation envelope"
    );
    if (!dataKey) {
      throw new Error("Repository data key is required");
    }
    const nonce = decodeBase64(String(envelope.nonce), "AES-GCM nonce");
    if (nonce.byteLength !== GCM_NONCE_BYTES) {
      throw new Error("AES-GCM nonce must contain 12 bytes");
    }
    const ciphertext = decodeBase64(
      String(envelope.ciphertext),
      "AES-GCM ciphertext"
    );
    const key = await importAesKey(dataKey, ["decrypt"]);
    const plaintext = decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: operationAad(envelope.repositoryId, envelope.opId),
        },
        key,
        ciphertext
      )
    );
    try {
      operation = JSON.parse(plaintext) as SyncOperation;
    } catch {
      throw new Error("Decrypted operation is not valid JSON");
    }
    if (canonicalStringify(operation) !== plaintext) {
      throw new Error("Encrypted operation is not canonically serialized");
    }
  } else {
    assertAllowedKeys(
      envelope,
      [
        "formatVersion",
        "repositoryId",
        "opId",
        "encrypted",
        "plaintextHash",
        "operation",
      ],
      "Plain operation envelope"
    );
    operation = envelope.operation as SyncOperation;
    if (typeof envelope.plaintextHash !== "string") {
      throw new Error("Plain operation envelope hash is missing");
    }
    const expectedHash = await sha256(canonicalStringify(operation));
    if (envelope.plaintextHash !== expectedHash) {
      throw new Error("Plain operation envelope hash does not match");
    }
  }

  if (
    operation.repositoryId !== envelope.repositoryId ||
    operation.opId !== envelope.opId
  ) {
    throw new Error("Operation envelope header does not match its payload");
  }
  await assertOperation(operation);
  return operation;
}

export async function createWrappedDataKey(
  header: RepositoryEncryptionHeader,
  kek: Uint8Array,
  dataKey: Uint8Array,
  nonceValue?: Uint8Array
): Promise<WrappedDataKey> {
  const nonce = requireNonce(nonceValue);
  const key = await importAesKey(kek, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: wrappedKeyAad(header),
      },
      key,
      requireAesKey(dataKey, "Repository data key")
    )
  );
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  };
}

export async function unwrapDataKey(
  header: RepositoryEncryptionHeader,
  kek: Uint8Array,
  wrapped: WrappedDataKey
) {
  const nonce = decodeBase64(wrapped.nonce, "Wrapped key nonce");
  if (nonce.byteLength !== GCM_NONCE_BYTES) {
    throw new Error("Wrapped key nonce must contain 12 bytes");
  }
  const ciphertext = decodeBase64(wrapped.ciphertext, "Wrapped key ciphertext");
  const key = await importAesKey(kek, ["decrypt"]);
  const dataKey = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: wrappedKeyAad(header),
      },
      key,
      ciphertext
    )
  );
  return requireAesKey(dataKey, "Repository data key");
}
