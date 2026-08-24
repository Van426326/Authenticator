import { assert } from "chai";
import {
  createOperation,
  createOperationEnvelope,
} from "../../sync/SyncCrypto";
import { SyncConflictService } from "../../sync/SyncConflictService";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const entityId = "22222222-2222-4222-8222-222222222222";

async function operation(opId: string, deviceId: string, secret: string) {
  return createOperation({
    formatVersion: 1,
    repositoryId,
    opId,
    deviceId,
    entityType: "otp",
    entityId,
    kind: "upsert",
    parents: [],
    createdAt: 1,
    payload: { type: "totp", secret },
  });
}

describe("SyncConflictService", () => {
  it("returns every authenticated conflict branch for manual resolution", async () => {
    const first = await operation(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "AAAA",
    );
    const second = await operation(
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "BBBB",
    );
    const service = new SyncConflictService(
      {
        async listStoredEnvelopes() {
          return [
            {
              opId: first.opId,
              envelope: await createOperationEnvelope(first, "none"),
            },
            {
              opId: second.opId,
              envelope: await createOperationEnvelope(second, "none"),
            },
          ];
        },
      },
      {
        async getSession() {
          return { repositoryId, mode: "none" as const, initialized: true };
        },
      },
    );

    const conflicts = await service.list();

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].entityId, entityId);
    assert.deepEqual(
      conflicts[0].branches.map((branch) => branch.payload),
      [
        { type: "totp", secret: "AAAA" },
        { type: "totp", secret: "BBBB" },
      ],
    );
  });

  it("redacts branch payloads while local accounts are locked", async () => {
    const first = await operation(
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "AAAA",
    );
    const second = await operation(
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "BBBB",
    );
    const service = new SyncConflictService(
      {
        async listStoredEnvelopes() {
          return [
            {
              opId: first.opId,
              envelope: await createOperationEnvelope(first, "none"),
            },
            {
              opId: second.opId,
              envelope: await createOperationEnvelope(second, "none"),
            },
          ];
        },
      },
      {
        async getSession() {
          return { repositoryId, mode: "none" as const, initialized: true };
        },
      },
      { isUnlocked: async () => false },
    );

    const conflicts = await service.list();

    assert.deepEqual(
      conflicts[0].branches.map((branch) => branch.payload),
      [undefined, undefined],
    );
  });
});
