import "mocha";
import { assert } from "chai";
import { IDBFactory } from "fake-indexeddb";

import {
  IndexedDbSyncJournal,
  RemoteOperationEnvelope,
  SyncMutationIntent,
} from "../../sync/SyncJournal";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";

async function assertRejects(promise: Promise<unknown>) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert.isTrue(rejected, "expected promise to reject");
}

function intent(intentId: string): SyncMutationIntent {
  return {
    intentId,
    repositoryId,
    entityType: "otp",
    entityId: "account-1",
    kind: "upsert",
    parents: [],
    createdAt: 1,
    localApplied: false,
  };
}

function createLegacyJournalDatabase(
  indexedDb: IDBFactory,
  databaseName: string,
  pending: SyncMutationIntent,
) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("intents", { keyPath: "intentId" });
      request.result.createObjectStore("operations", { keyPath: "opId" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("intents", "readwrite");
      transaction.objectStore("intents").add(pending);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    };
  });
}

describe("IndexedDbSyncJournal", () => {
  let indexedDb: IDBFactory;
  let journal: IndexedDbSyncJournal;

  beforeEach(() => {
    indexedDb = new IDBFactory();
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");
  });

  afterEach(async () => {
    journal.close();
    await journal.deleteDatabase();
  });

  it("upgrades a version-1 journal without losing existing intents", async () => {
    const pending = intent("legacy-intent");
    await createLegacyJournalDatabase(indexedDb, "sync-journal-test", pending);
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");

    assert.deepEqual(await journal.listIntents(repositoryId), [pending]);
    await journal.quarantineRemoteOperation({
      opId: "corrupt-operation-1",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "corrupt-envelope",
      error: "invalid",
    });
    assert.deepEqual(await journal.listQuarantinedOperationIds(repositoryId), [
      "corrupt-operation-1",
    ]);
  });

  it("persists an intent before the local mutation is applied", async () => {
    const pending = intent("intent-1");

    await journal.enqueueIntent(pending);
    journal.close();
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");

    assert.deepEqual(await journal.listIntents(repositoryId), [pending]);
  });

  it("marks an intent as locally applied without losing its causal parents", async () => {
    const pending = {
      ...intent("intent-1"),
      parents: ["parent-1", "parent-2"],
    };

    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);

    assert.deepInclude((await journal.listIntents(repositoryId))[0], {
      localApplied: true,
      parents: ["parent-1", "parent-2"],
    });
  });

  it("fixes envelope bytes the first time an intent is materialized", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);

    const first = await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
      deviceId,
    );
    const replay = await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
      deviceId,
    );

    assert.deepEqual(replay, first);
    assert.deepEqual(
      await journal.getOperationForIntent(pending.intentId),
      first,
    );
    await assertRejects(
      journal.materializeIntent(
        pending.intentId,
        "operation-1",
        "different-envelope",
        deviceId,
      ),
    );
    await assertRejects(
      journal.materializeIntent(
        pending.intentId,
        "operation-1",
        "fixed-envelope",
        "33333333-3333-4333-8333-333333333333",
      ),
    );
  });

  it("tracks applied intents that still need materialization", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);

    const dirty = await journal.listDirtyIntents(repositoryId);
    assert.deepEqual(dirty, [{ ...pending, localApplied: true }]);

    await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
    );

    assert.deepEqual(await journal.listDirtyIntents(repositoryId), []);
  });

  it("keeps a superseded dirty edit for audit but removes it from materialization", async () => {
    const edit = { ...intent("intent-edit"), createdAt: 1 };
    const deletion = {
      ...intent("intent-delete"),
      kind: "delete" as const,
      createdAt: 2,
    };
    await journal.enqueueIntent(edit);
    await journal.enqueueIntent(deletion);
    await journal.markIntentApplied(edit.intentId);
    await journal.markIntentApplied(deletion.intentId);

    await journal.markIntentSuperseded(edit.intentId, deletion.intentId);

    assert.deepEqual(
      (await journal.listIntents(repositoryId)).find(
        (candidate) => candidate.intentId === edit.intentId,
      )?.supersededByIntentId,
      deletion.intentId,
    );
    assert.deepEqual(
      (await journal.listDirtyIntents(repositoryId)).map(
        (candidate) => candidate.intentId,
      ),
      [deletion.intentId],
    );
  });

  it("does not expose an operation to the outbox before local apply succeeds", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
    );

    assert.deepEqual(await journal.listOutbox(repositoryId), []);

    await journal.markIntentApplied(pending.intentId);

    assert.lengthOf(await journal.listOutbox(repositoryId), 1);
  });

  it("keeps applied operations in the outbox until acknowledged", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);
    await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
    );

    assert.lengthOf(await journal.listOutbox(repositoryId), 1);

    await journal.markRemoteAcknowledged("operation-1");

    assert.deepEqual(await journal.listOutbox(repositoryId), []);
  });

  it("persists the acknowledged operation content address across restart", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);
    await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
    );

    await journal.markRemoteAcknowledged("operation-1", "remote-sha-1");
    journal.close();
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");

    const operations = await journal.listLocalOperations(repositoryId);
    assert.equal(operations[0].opId, "operation-1");
    assert.equal(operations[0].remoteSha, "remote-sha-1");
    assert.equal(operations[0].remoteAcknowledged, true);
  });

  it("rejects acknowledging with a conflicting content address", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);
    await journal.materializeIntent(
      pending.intentId,
      "operation-1",
      "fixed-envelope",
    );
    await journal.markRemoteAcknowledged("operation-1", "remote-sha-1");

    await assertRejects(
      journal.markRemoteAcknowledged("operation-1", "remote-sha-2"),
    );
  });

  it("attaches a content address to legacy records and persists it", async () => {
    await journal.storeRemoteOperation({
      opId: "remote-operation-sha",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "remote-envelope",
    });

    await journal.attachRemoteSha("remote-operation-sha", "remote-sha-1");
    journal.close();
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");

    const operations = await journal.listRemoteOperations(repositoryId);
    const operation = operations.find(
      (candidate) => candidate.opId === "remote-operation-sha",
    );
    assert.equal(operation?.remoteSha, "remote-sha-1");
  });

  it("rejects attaching a conflicting content address to a legacy record", async () => {
    await journal.storeRemoteOperation({
      opId: "remote-operation-sha",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "remote-envelope",
      remoteSha: "remote-sha-1",
    });

    await assertRejects(
      journal.attachRemoteSha("remote-operation-sha", "remote-sha-2"),
    );
  });

  it("allows an applied intent to be re-enqueued idempotently", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);

    await journal.enqueueIntent(pending);

    assert.isTrue((await journal.getIntent(pending.intentId))?.localApplied);
  });

  it("rejects reusing an intent id for different causal data", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);

    await assertRejects(
      journal.enqueueIntent({ ...pending, entityId: "another-account" }),
    );
  });

  it("persists immutable remote envelopes and known operation ids", async () => {
    await journal.storeRemoteOperation({
      opId: "remote-operation-1",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "remote-envelope",
    });
    journal.close();
    journal = new IndexedDbSyncJournal(indexedDb, "sync-journal-test");

    assert.deepEqual(await journal.listKnownOperationIds(repositoryId), [
      "remote-operation-1",
    ]);
    assert.deepEqual(await journal.listStoredEnvelopes(repositoryId), [
      { opId: "remote-operation-1", envelope: "remote-envelope" },
    ]);
  });

  it("rejects changed remote bytes for an existing operation id", async () => {
    const remote: RemoteOperationEnvelope = {
      opId: "remote-operation-1",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "remote-envelope",
    };
    await journal.storeRemoteOperation(remote);
    await journal.storeRemoteOperation(remote);

    await assertRejects(
      journal.storeRemoteOperation({
        ...remote,
        envelope: "changed-envelope",
      }),
    );
  });

  it("tracks entity heads independently", async () => {
    const first = {
      ...intent("intent-1"),
      entityId: "account-1",
      parents: ["remote-parent"],
    };
    const second = {
      ...intent("intent-2"),
      entityId: "account-2",
      parents: ["remote-parent"],
    };

    await journal.advanceEntityHeads(first, "operation-1");
    await journal.advanceEntityHeads(second, "operation-2");

    assert.deepEqual(
      await journal.getEntityHeads(repositoryId, "otp", first.entityId),
      ["operation-1"],
    );
    assert.deepEqual(
      await journal.getEntityHeads(repositoryId, "otp", second.entityId),
      ["operation-2"],
    );
  });

  it("preserves sibling heads for concurrent mutations of one entity", async () => {
    const first = { ...intent("intent-1"), entityId: "account-1" };
    const second = { ...intent("intent-2"), entityId: "account-1" };

    await journal.advanceEntityHeads(first, "operation-1");
    await journal.advanceEntityHeads(second, "operation-2");

    assert.deepEqual(
      await journal.getEntityHeads(repositoryId, "otp", "account-1"),
      ["operation-1", "operation-2"],
    );
  });

  it("quarantines corrupt remote bytes without treating them as applicable", async () => {
    await journal.quarantineRemoteOperation({
      opId: "corrupt-operation-1",
      repositoryId,
      deviceId: "remote-device-1",
      envelope: "corrupt-envelope",
      error: "invalid tag",
    });

    assert.deepEqual(await journal.listQuarantinedOperationIds(repositoryId), [
      "corrupt-operation-1",
    ]);
    assert.deepEqual(await journal.listStoredEnvelopes(repositoryId), []);
  });

  it("forgets only the selected repository history", async () => {
    const pending = intent("intent-forget");
    await journal.enqueueIntent(pending);
    await journal.materializeIntent(
      pending.intentId,
      "operation-forget",
      "fixed-envelope",
    );
    await journal.markIntentApplied(pending.intentId);
    await journal.advanceEntityHeads(pending, "operation-forget");
    await journal.storeRemoteOperation({
      repositoryId,
      deviceId: "remote-device",
      opId: "remote-forget",
      envelope: "remote-envelope",
    });
    await journal.quarantineRemoteOperation({
      repositoryId,
      deviceId: "remote-device",
      opId: "quarantine-forget",
      envelope: "bad-envelope",
      error: "bad",
    });

    await journal.deleteRepositoryData(repositoryId);

    assert.deepEqual(await journal.listIntents(repositoryId), []);
    assert.deepEqual(await journal.listStoredEnvelopes(repositoryId), []);
    assert.deepEqual(
      await journal.listQuarantinedOperationIds(repositoryId),
      [],
    );
    assert.deepEqual(
      await journal.getEntityHeads(repositoryId, "otp", pending.entityId),
      [],
    );
  });

  it("includes local materialized operations in known and stored sets", async () => {
    const pending = intent("intent-1");
    await journal.enqueueIntent(pending);
    await journal.markIntentApplied(pending.intentId);
    await journal.materializeIntent(
      pending.intentId,
      "local-operation-1",
      "local-envelope",
    );

    assert.deepEqual(await journal.listKnownOperationIds(repositoryId), [
      "local-operation-1",
    ]);
    assert.deepEqual(await journal.listStoredEnvelopes(repositoryId), [
      { opId: "local-operation-1", envelope: "local-envelope" },
    ]);
  });
});
