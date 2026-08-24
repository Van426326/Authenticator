import { decodeBase64 } from "./Base64";
import { canonicalStringify } from "./OperationReducer";
import {
  Argon2idKdfConfig,
  createWrappedDataKey,
  RepositoryEncryptionHeader,
  unwrapDataKey,
  validateKdfConfig,
  WrappedDataKey,
} from "./SyncCrypto";

const MAX_CONFIG_BYTES = 16 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accessBrand: unique symbol = Symbol("RepositoryAccess");

export interface UnencryptedRepositoryConfig {
  protocolVersion: 1;
  repositoryId: string;
  createdAt: number;
  encryption: {
    mode: "none";
  };
}

export interface EncryptedRepositoryConfig {
  protocolVersion: 1;
  repositoryId: string;
  createdAt: number;
  encryption: {
    mode: "aes-256-gcm";
    kdf: Argon2idKdfConfig;
    wrappedDataKey: WrappedDataKey;
  };
}

export type RepositoryConfig =
  | UnencryptedRepositoryConfig
  | EncryptedRepositoryConfig;

export class RepositoryPasswordError extends Error {
  constructor() {
    super("The sync password is missing or incorrect");
    this.name = "RepositoryPasswordError";
  }
}

export interface RepositoryAccess {
  readonly repositoryId: string;
  readonly fingerprint: string;
  readonly mode: "none" | "aes-256-gcm";
  readonly dataKey?: Uint8Array;
  readonly [accessBrand]: true;
}

export interface RepositoryConfigOptions {
  repositoryId?: string;
  createdAt?: number;
}

export interface EncryptedRepositoryConfigOptions
  extends RepositoryConfigOptions {
  dataKey?: Uint8Array;
  nonce?: Uint8Array;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string
) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function requireRecord(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function assertRepositoryConfig(
  config: unknown
): asserts config is RepositoryConfig {
  const value = requireRecord(config, "Repository config");
  assertAllowedKeys(
    value,
    ["protocolVersion", "repositoryId", "createdAt", "encryption"],
    "Repository config"
  );
  if (
    value.protocolVersion !== 1 ||
    typeof value.repositoryId !== "string" ||
    !UUID_V4.test(value.repositoryId) ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0
  ) {
    throw new Error("Repository config header is invalid");
  }

  const encryption = requireRecord(value.encryption, "Repository encryption");
  if (encryption.mode === "none") {
    assertAllowedKeys(encryption, ["mode"], "Repository encryption");
    return;
  }
  if (encryption.mode !== "aes-256-gcm") {
    throw new Error("Repository encryption mode is unsupported");
  }
  assertAllowedKeys(
    encryption,
    ["mode", "kdf", "wrappedDataKey"],
    "Repository encryption"
  );

  const kdf = requireRecord(encryption.kdf, "Repository KDF");
  assertAllowedKeys(
    kdf,
    ["name", "salt", "time", "memoryKiB", "parallelism", "hashLength"],
    "Repository KDF"
  );
  validateKdfConfig((kdf as unknown) as Argon2idKdfConfig);

  const wrapped = requireRecord(
    encryption.wrappedDataKey,
    "Wrapped repository data key"
  );
  assertAllowedKeys(
    wrapped,
    ["nonce", "ciphertext"],
    "Wrapped repository data key"
  );
  if (
    typeof wrapped.nonce !== "string" ||
    typeof wrapped.ciphertext !== "string"
  ) {
    throw new Error("Wrapped repository data key is invalid");
  }
  if (
    decodeBase64(wrapped.nonce, "Wrapped key nonce").byteLength !== 12 ||
    decodeBase64(wrapped.ciphertext, "Wrapped key ciphertext").byteLength !== 48
  ) {
    throw new Error("Wrapped repository data key has an invalid length");
  }
}

function repositoryId(options: RepositoryConfigOptions) {
  const value = options.repositoryId || crypto.randomUUID();
  if (!UUID_V4.test(value)) {
    throw new Error("Repository id must be a lowercase UUIDv4");
  }
  return value;
}

function createdAt(options: RepositoryConfigOptions) {
  const value = options.createdAt ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Repository creation time is invalid");
  }
  return value;
}

export function createUnencryptedRepositoryConfig(
  options: RepositoryConfigOptions = {}
): UnencryptedRepositoryConfig {
  return {
    protocolVersion: 1,
    repositoryId: repositoryId(options),
    createdAt: createdAt(options),
    encryption: { mode: "none" },
  };
}

export async function createEncryptedRepositoryConfig(
  kdf: Argon2idKdfConfig,
  kek: Uint8Array,
  options: EncryptedRepositoryConfigOptions = {}
) {
  validateKdfConfig(kdf);
  const id = repositoryId(options);
  const dataKey = options.dataKey
    ? Uint8Array.from(options.dataKey)
    : crypto.getRandomValues(new Uint8Array(32));
  const header: RepositoryEncryptionHeader = {
    protocolVersion: 1,
    repositoryId: id,
    mode: "aes-256-gcm",
    kdf: { ...kdf },
  };
  const wrappedDataKey = await createWrappedDataKey(
    header,
    kek,
    dataKey,
    options.nonce
  );
  const config: EncryptedRepositoryConfig = {
    protocolVersion: 1,
    repositoryId: id,
    createdAt: createdAt(options),
    encryption: {
      mode: "aes-256-gcm",
      kdf: { ...kdf },
      wrappedDataKey,
    },
  };
  assertRepositoryConfig(config);
  return { config, dataKey };
}

export function serializeRepositoryConfig(config: RepositoryConfig) {
  assertRepositoryConfig(config);
  const serialized = canonicalStringify(config);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
    throw new Error("Repository config exceeds the size limit");
  }
  return serialized;
}

export function parseRepositoryConfig(serialized: string): RepositoryConfig {
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
    throw new Error("Repository config exceeds the size limit");
  }
  // GitHub / Git may persist a trailing newline after the JSON blob.
  const normalized = serialized.replace(/\s+$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("Repository config is not valid JSON");
  }
  assertRepositoryConfig(parsed);
  if (canonicalStringify(parsed) !== normalized) {
    throw new Error("Repository config is not canonically serialized");
  }
  return parsed;
}

export async function repositoryConfigFingerprint(config: RepositoryConfig) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializeRepositoryConfig(config))
    )
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export async function verifyRepositoryAccess(
  config: RepositoryConfig,
  kek?: Uint8Array
): Promise<RepositoryAccess> {
  const fingerprint = await repositoryConfigFingerprint(config);
  if (config.encryption.mode === "none") {
    return {
      repositoryId: config.repositoryId,
      fingerprint,
      mode: "none",
      [accessBrand]: true,
    };
  }
  if (!kek) {
    throw new RepositoryPasswordError();
  }
  let dataKey: Uint8Array;
  try {
    dataKey = await unwrapDataKey(
      {
        protocolVersion: config.protocolVersion,
        repositoryId: config.repositoryId,
        mode: config.encryption.mode,
        kdf: config.encryption.kdf,
      },
      kek,
      config.encryption.wrappedDataKey
    );
  } catch {
    throw new RepositoryPasswordError();
  }
  return {
    repositoryId: config.repositoryId,
    fingerprint,
    mode: "aes-256-gcm",
    dataKey,
    [accessBrand]: true,
  };
}
