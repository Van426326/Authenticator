import { assert } from "chai";
import { SyncMutationFactory } from "../../sync/SyncMutationFactory";
import { openOperationEnvelope } from "../../sync/SyncCrypto";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const entityId = "33333333-3333-4333-8333-333333333333";

function factory(options: {
  configured?: boolean;
  mode?: "none" | "aes-256-gcm";
  dataKey?: Uint8Array;
}) {
  const mode = options.mode ?? "none";
  return new SyncMutationFactory(
    {
      async get() {
        return options.configured === false
          ? undefined
          : { repositoryId, initialized: true };
      },
    },
    {
      async getSession() {
        return {
          repositoryId,
          mode,
          initialized: true,
          dataKey: options.dataKey,
        };
      },
    },
    {
      async getEntityHeads() {
        return ["44444444-4444-4444-8444-444444444444"];
      },
    },
    deviceId,
    () => 42,
  );
}

describe("SyncMutationFactory", () => {
  it("lets unconfigured callers use ordinary local persistence", async () => {
    assert.isUndefined(
      await factory({ configured: false }).create({
        entityType: "otp",
        entityId,
        kind: "upsert",
        logicalPayload: { type: "totp", secret: "AAAA" },
      }),
    );
  });

  it("creates a fixed plaintext envelope using durable entity heads", async () => {
    const mutation = await factory({}).create({
      entityType: "otp",
      entityId,
      kind: "upsert",
      logicalPayload: { type: "totp", secret: "AAAA" },
    });

    assert.exists(mutation?.materialized);
    assert.deepEqual(mutation?.intent.parents, [
      "44444444-4444-4444-8444-444444444444",
    ]);
    assert.equal(mutation?.intent.createdAt, 42);
    const operation = await openOperationEnvelope(
      mutation?.materialized?.envelope as string,
      "none",
    );
    assert.equal(operation.deviceId, deviceId);
    assert.deepEqual(operation.payload, { type: "totp", secret: "AAAA" });
  });

  it("keeps a dirty intent when the encrypted repository key is unavailable", async () => {
    const mutation = await factory({ mode: "aes-256-gcm" }).create({
      entityType: "otp",
      entityId,
      kind: "delete",
      logicalPayload: null,
    });

    assert.isUndefined(mutation?.materialized);
    assert.deepEqual(mutation?.intent.parents, [
      "44444444-4444-4444-8444-444444444444",
    ]);
    assert.isNull(mutation?.logicalPayload);
  });
});
