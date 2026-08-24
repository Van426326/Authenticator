import "mocha";
import { assert } from "chai";

import { canonicalStringify, SyncOperation } from "../../sync/OperationReducer";
import {
  createOperation,
  createOperationEnvelope,
  createWrappedDataKey,
  openOperationEnvelope,
  unwrapDataKey,
  validateKdfConfig,
} from "../../sync/SyncCrypto";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";

function bytes(value: number) {
  return new Uint8Array(32).fill(value);
}

async function assertRejects(promise: Promise<unknown>) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, Error);
}

async function operation(): Promise<SyncOperation> {
  return createOperation({
    formatVersion: 1,
    opId: "22222222-2222-4222-8222-222222222222",
    repositoryId,
    deviceId: "33333333-3333-4333-8333-333333333333",
    entityType: "otp",
    entityId: "44444444-4444-4444-8444-444444444444",
    kind: "upsert",
    parents: [],
    createdAt: 1,
    payload: {
      type: "totp",
      secret: "fixture-otp-value",
      issuer: "Example",
    },
  });
}

const kdf = {
  name: "argon2id" as const,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  time: 2,
  memoryKiB: 19456,
  parallelism: 1,
  hashLength: 32,
};

describe("SyncCrypto", () => {
  it("encrypts and authenticates an operation with stable envelope bytes", async () => {
    const logicalOperation = await operation();
    const dataKey = bytes(7);
    const nonce = new Uint8Array(12).fill(9);

    const first = await createOperationEnvelope(
      logicalOperation,
      "aes-256-gcm",
      dataKey,
      nonce,
    );
    const second = await createOperationEnvelope(
      logicalOperation,
      "aes-256-gcm",
      dataKey,
      nonce,
    );

    assert.equal(first, second);
    assert.deepEqual(
      await openOperationEnvelope(first, "aes-256-gcm", dataKey),
      logicalOperation,
    );
  });

  it("rejects a wrong key and authenticated-header substitution", async () => {
    const logicalOperation = await operation();
    const envelope = await createOperationEnvelope(
      logicalOperation,
      "aes-256-gcm",
      bytes(1),
      new Uint8Array(12).fill(2),
    );

    await assertRejects(
      openOperationEnvelope(envelope, "aes-256-gcm", bytes(3)),
    );

    const parsed = JSON.parse(envelope) as Record<string, unknown>;
    parsed.opId = "55555555-5555-4555-8555-555555555555";
    await assertRejects(
      openOperationEnvelope(
        canonicalStringify(parsed),
        "aes-256-gcm",
        bytes(1),
      ),
    );
  });

  it("detects plaintext payload tampering", async () => {
    const logicalOperation = await operation();
    const envelope = await createOperationEnvelope(logicalOperation, "none");
    const parsed = JSON.parse(envelope) as {
      operation: SyncOperation;
    };
    parsed.operation.payload = {
      type: "totp",
      secret: "tampered-fixture-value",
    };

    await assertRejects(
      openOperationEnvelope(canonicalStringify(parsed), "none"),
    );
  });

  it("rejects envelopes whose encryption mode differs from repository config", async () => {
    const logicalOperation = await operation();
    const plain = await createOperationEnvelope(logicalOperation, "none");
    const encrypted = await createOperationEnvelope(
      logicalOperation,
      "aes-256-gcm",
      bytes(1),
      new Uint8Array(12).fill(2),
    );

    await assertRejects(openOperationEnvelope(plain, "aes-256-gcm", bytes(1)));
    await assertRejects(openOperationEnvelope(encrypted, "none"));
  });

  it("rejects malformed ids, payload fields, and non-canonical envelopes", async () => {
    const valid = await operation();
    await assertRejects(
      createOperationEnvelope({ ...valid, opId: "not-a-uuid" }, "none"),
    );
    await assertRejects(
      createOperation({
        formatVersion: 1,
        opId: "77777777-7777-4777-8777-777777777777",
        repositoryId,
        deviceId: "33333333-3333-4333-8333-333333333333",
        entityType: "otp",
        entityId: "44444444-4444-4444-8444-444444444444",
        kind: "upsert",
        parents: [],
        createdAt: 1,
        payload: {
          type: "totp",
          secret: "fixture-otp-value",
          digits: 11,
        },
      }),
    );

    const envelope = await createOperationEnvelope(valid, "none");
    await assertRejects(
      openOperationEnvelope(
        JSON.stringify(JSON.parse(envelope), null, 2),
        "none",
      ),
    );
  });

  it("wraps the repository data key with authenticated config metadata", async () => {
    const dataKey = bytes(4);
    const kek = bytes(8);
    const wrapped = await createWrappedDataKey(
      {
        protocolVersion: 1,
        repositoryId,
        mode: "aes-256-gcm",
        kdf,
      },
      kek,
      dataKey,
      new Uint8Array(12).fill(6),
    );

    assert.deepEqual(
      Array.from(
        await unwrapDataKey(
          {
            protocolVersion: 1,
            repositoryId,
            mode: "aes-256-gcm",
            kdf,
          },
          kek,
          wrapped,
        ),
      ),
      Array.from(dataKey),
    );

    await assertRejects(
      unwrapDataKey(
        {
          protocolVersion: 1,
          repositoryId: "66666666-6666-4666-8666-666666666666",
          mode: "aes-256-gcm",
          kdf,
        },
        kek,
        wrapped,
      ),
    );
  });

  it("rejects weak or excessive Argon2id parameters", () => {
    assert.throws(() => validateKdfConfig({ ...kdf, memoryKiB: 8192 }));
    assert.throws(() => validateKdfConfig({ ...kdf, memoryKiB: 524288 }));
    assert.throws(() => validateKdfConfig({ ...kdf, hashLength: 16 }));
    assert.deepEqual(validateKdfConfig(kdf), kdf);
  });
});
