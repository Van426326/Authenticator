import "mocha";
import { assert } from "chai";

import { SyncOperation } from "../../sync/OperationReducer";
import { deriveSyncState, LogicalOtpPayload } from "../../sync/SyncState";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

function otpOperation(
  opId: string,
  entityId: string,
  payload: LogicalOtpPayload,
  parents: string[] = [],
): SyncOperation {
  return {
    formatVersion: 1,
    repositoryId,
    opId,
    deviceId,
    entityType: "otp",
    entityId,
    kind: "upsert",
    parents,
    createdAt: 1,
    contentHash: `hash-${opId}`,
    payload,
  };
}

function orderOperation(opId: string, ids: string[]): SyncOperation {
  return {
    formatVersion: 1,
    repositoryId,
    opId,
    deviceId,
    entityType: "order",
    entityId: "global-order",
    kind: "upsert",
    parents: [],
    createdAt: 1,
    contentHash: `hash-${opId}`,
    payload: { ids },
  };
}

describe("SyncState", () => {
  it("merges concurrent HOTP counters monotonically without a conflict", () => {
    const root = otpOperation(
      "00000000-0000-4000-8000-000000000001",
      "hotp-account",
      { type: "hotp", secret: "ABC", counter: 1 },
    );
    const left = otpOperation(
      "00000000-0000-4000-8000-000000000002",
      "hotp-account",
      { type: "hotp", secret: "ABC", counter: 2 },
      [root.opId],
    );
    const right = otpOperation(
      "00000000-0000-4000-8000-000000000003",
      "hotp-account",
      { type: "hotp", secret: "ABC", counter: 4 },
      [root.opId],
    );

    const state = deriveSyncState([right, root, left], repositoryId);

    assert.equal(state.entries[0].payload.counter, 4);
    assert.deepEqual(state.entries[0].conflicts, []);
    assert.deepEqual(state.conflicts, []);
  });

  it("does not let a faulty descendant regress a HOTP counter", () => {
    const root = otpOperation(
      "00000000-0000-4000-8000-000000000001",
      "hotp-account",
      { type: "hotp", secret: "ABC", counter: 10 },
    );
    const regressed = otpOperation(
      "00000000-0000-4000-8000-000000000002",
      "hotp-account",
      { type: "hotp", secret: "ABC", counter: 3 },
      [root.opId],
    );

    const state = deriveSyncState([regressed, root], repositoryId);

    assert.equal(state.entries[0].payload.counter, 10);
  });

  it("keeps non-counter HOTP differences as conflicts while using max counter", () => {
    const root = otpOperation(
      "00000000-0000-4000-8000-000000000001",
      "hotp-account",
      { type: "hotp", secret: "ABC", account: "root", counter: 1 },
    );
    const left = otpOperation(
      "00000000-0000-4000-8000-000000000002",
      "hotp-account",
      { type: "hotp", secret: "ABC", account: "left", counter: 2 },
      [root.opId],
    );
    const right = otpOperation(
      "00000000-0000-4000-8000-000000000003",
      "hotp-account",
      { type: "hotp", secret: "ABC", account: "right", counter: 5 },
      [root.opId],
    );

    const state = deriveSyncState([root, left, right], repositoryId);

    assert.equal(state.entries[0].payload.counter, 5);
    assert.lengthOf(state.entries[0].conflicts, 1);
  });

  it("rejects structurally invalid HOTP counters", () => {
    const invalid = otpOperation(
      "00000000-0000-4000-8000-000000000001",
      "hotp-account",
      {
        type: "hotp",
        secret: "ABC",
        counter: "3",
      } as unknown as LogicalOtpPayload,
    );

    assert.throws(() => deriveSyncState([invalid], repositoryId));
  });

  it("derives order independently and appends missing accounts by root op id", () => {
    const laterRoot = otpOperation(
      "00000000-0000-4000-8000-000000000020",
      "later",
      { type: "totp", secret: "LATER" },
    );
    const earlierRoot = otpOperation(
      "00000000-0000-4000-8000-000000000010",
      "earlier",
      { type: "totp", secret: "EARLIER" },
    );
    const listed = otpOperation(
      "00000000-0000-4000-8000-000000000030",
      "listed",
      { type: "totp", secret: "LISTED" },
    );
    const order = orderOperation("00000000-0000-4000-8000-000000000040", [
      "listed",
    ]);

    const state = deriveSyncState(
      [laterRoot, order, listed, earlierRoot],
      repositoryId,
    );

    assert.deepEqual(state.order, ["listed", "earlier", "later"]);
  });
});
