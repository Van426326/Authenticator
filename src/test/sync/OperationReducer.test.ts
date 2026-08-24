import "mocha";
import { assert } from "chai";

import {
  canonicalStringify,
  reduceOperations,
  SyncOperation,
} from "../../sync/OperationReducer";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

function operation(
  opId: string,
  options: Partial<SyncOperation> = {},
): SyncOperation {
  return {
    formatVersion: 1,
    repositoryId,
    opId,
    deviceId,
    entityType: "otp",
    entityId: "account-1",
    kind: "upsert",
    parents: [],
    createdAt: 1,
    contentHash: `hash-${opId}`,
    payload: { account: opId },
    ...options,
  };
}

describe("OperationReducer", () => {
  it("reduces the same operation set independently of arrival order", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");
    const left = operation("00000000-0000-4000-8000-000000000002", {
      parents: [root.opId],
    });
    const right = operation("00000000-0000-4000-8000-000000000003", {
      parents: [root.opId],
    });

    const first = reduceOperations([root, left, right], repositoryId);
    const second = reduceOperations([right, root, left], repositoryId);

    assert.deepEqual(second, first);
    assert.deepEqual(first.entities[0].heads, [left, right]);
  });

  it("is idempotent when an identical operation is received twice", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");

    assert.deepEqual(
      reduceOperations([root, root], repositoryId),
      reduceOperations([root], repositoryId),
    );
  });

  it("does not trust matching content hashes for different payloads", () => {
    const left = operation("00000000-0000-4000-8000-000000000001", {
      contentHash: "claimed-equal",
      payload: { account: "left" },
    });
    const right = operation("00000000-0000-4000-8000-000000000002", {
      contentHash: "claimed-equal",
      payload: { account: "right" },
    });

    const result = reduceOperations([left, right], repositoryId);

    assert.lengthOf(result.entities[0].conflicts, 1);
  });

  it("prefers a concurrent deletion while preserving the edited branch", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");
    const edit = operation("00000000-0000-4000-8000-000000000002", {
      parents: [root.opId],
    });
    const deletion = operation("00000000-0000-4000-8000-000000000003", {
      kind: "delete",
      parents: [root.opId],
      contentHash: "deleted",
      payload: null,
    });

    const result = reduceOperations([root, edit, deletion], repositoryId);
    const entity = result.entities[0];

    assert.equal(entity.primary.opId, deletion.opId);
    assert.isTrue(entity.deleted);
    assert.deepEqual(entity.conflicts, [edit]);
  });

  it("lets a causal successor dominate every referenced branch", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");
    const left = operation("00000000-0000-4000-8000-000000000002", {
      parents: [root.opId],
    });
    const right = operation("00000000-0000-4000-8000-000000000003", {
      parents: [root.opId],
    });
    const resolution = operation("00000000-0000-4000-8000-000000000004", {
      kind: "resolve",
      parents: [left.opId, right.opId],
      contentHash: "resolved",
      payload: {
        resolution: "upsert",
        entry: { account: "resolved" },
      },
    });

    const result = reduceOperations(
      [right, resolution, root, left],
      repositoryId,
    );

    assert.deepEqual(result.entities[0].heads, [resolution]);
    assert.deepEqual(result.entities[0].conflicts, []);
    assert.isFalse(result.entities[0].deleted);
  });

  it("defers operations whose causal parents are missing", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");
    const pending = operation("00000000-0000-4000-8000-000000000002", {
      parents: ["00000000-0000-4000-8000-000000000099"],
    });
    const pendingChild = operation("00000000-0000-4000-8000-000000000003", {
      parents: [pending.opId],
    });

    const result = reduceOperations(
      [pendingChild, pending, root],
      repositoryId,
    );

    assert.deepEqual(result.entities[0].heads, [root]);
    assert.deepEqual(result.pending, [pending, pendingChild]);
  });

  it("rejects a causal cycle", () => {
    const left = operation("00000000-0000-4000-8000-000000000001", {
      parents: ["00000000-0000-4000-8000-000000000002"],
    });
    const right = operation("00000000-0000-4000-8000-000000000002", {
      parents: [left.opId],
    });

    assert.throws(() => reduceOperations([left, right], repositoryId));
  });

  it("rejects repository, identity, and parent integrity violations", () => {
    const root = operation("00000000-0000-4000-8000-000000000001");
    const duplicate = operation(root.opId, {
      contentHash: "different",
    });
    const foreign = operation("00000000-0000-4000-8000-000000000002", {
      repositoryId: "33333333-3333-4333-8333-333333333333",
    });
    const crossEntityParent = operation(
      "00000000-0000-4000-8000-000000000003",
      {
        entityId: "account-2",
        parents: [root.opId],
      },
    );

    assert.throws(() => reduceOperations([foreign], repositoryId));
    assert.throws(() => reduceOperations([root, duplicate], repositoryId));
    assert.throws(() =>
      reduceOperations([root, crossEntityParent], repositoryId),
    );
  });

  it("canonicalizes logical payloads with stable object key ordering", () => {
    assert.equal(
      canonicalStringify({ z: 1, a: { y: 2, b: 3 } }),
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });
});
