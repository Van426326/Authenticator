import "mocha";
import { assert } from "chai";

import {
  createOperation,
  createOperationEnvelope,
} from "../../sync/SyncCrypto";
import { SyncRunner } from "../../sync/SyncRunController";
import { DerivedSyncState } from "../../sync/SyncState";
import {
  DirtyIntentAccountMissingError,
  SyncEngine,
  SyncEngineJournal,
  SyncEngineLocalAdapter,
  SyncRepositorySession,
} from "../../sync/SyncEngine";
import {
  FlushReceipt,
  RemoteOperationFile,
  SyncEngineOperationStore,
} from "../../sync/SyncEngineTypes";
import {
  OutboxOperation,
  QuarantinedRemoteOperation,
  RemoteOperationEnvelope,
  StoredOperationEnvelope,
  SyncMutationIntent,
} from "../../sync/SyncJournal";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const localDeviceId = "22222222-2222-4222-8222-222222222222";
const remoteDeviceId = "33333333-3333-4333-8333-333333333333";
const secondRemoteDeviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const entityId = "44444444-4444-4444-8444-444444444444";

function bytes(value: number) {
  return new Uint8Array(32).fill(value);
}

class FakeJournal implements SyncEngineJournal {
  events: string[] = [];
  outbox: OutboxOperation[] = [];
  dirtyIntents: SyncMutationIntent[] = [];
  stored = new Map<string, string>();
  remoteDevices = new Map<string, string>();
  remoteShas = new Map<string, string>();
  quarantined = new Set<string>();

  async listOutbox() {
    return this.outbox.filter((operation) => !operation.remoteAcknowledged);
  }

  async listDirtyIntents() {
    return this.dirtyIntents;
  }

  async materializeIntent(
    intentId: string,
    opId: string,
    envelope: string,
    deviceId?: string,
  ) {
    this.events.push(`materialize:${intentId}`);
    const operation: OutboxOperation = {
      intentId,
      opId,
      repositoryId,
      envelope,
      ...(deviceId === undefined ? {} : { deviceId }),
      remoteAcknowledged: false,
    };
    this.outbox.push(operation);
    this.dirtyIntents = this.dirtyIntents.filter(
      (intent) => intent.intentId !== intentId,
    );
    return operation;
  }

  async markIntentSuperseded(intentId: string, supersededByIntentId: string) {
    this.events.push(`supersede:${intentId}:${supersededByIntentId}`);
    this.dirtyIntents = this.dirtyIntents.filter(
      (intent) => intent.intentId !== intentId,
    );
  }

  async advanceEntityHeads() {}

  async replaceEntityHeads() {}

  async listLocalOperations() {
    return this.outbox;
  }

  async listRemoteOperations(): Promise<RemoteOperationEnvelope[]> {
    return Array.from(this.stored, ([opId, envelope]) => ({
      opId,
      envelope,
      repositoryId,
      deviceId: this.remoteDevices.get(opId) || remoteDeviceId,
    }));
  }

  async markRemoteAcknowledged(opId: string, remoteSha?: string) {
    this.events.push(`ack:${opId}`);
    const operation = this.outbox.find((candidate) => candidate.opId === opId);
    if (operation) {
      operation.remoteAcknowledged = true;
      if (remoteSha !== undefined) {
        operation.remoteSha = remoteSha;
      }
    }
  }

  async attachLocalDeviceId(opId: string, deviceId: string) {
    this.events.push(`attachDevice:${opId}`);
    const operation = this.outbox.find((candidate) => candidate.opId === opId);
    if (operation) {
      operation.deviceId = deviceId;
    }
  }

  async attachRemoteSha(opId: string, remoteSha: string) {
    this.events.push(`attachSha:${opId}`);
    this.remoteShas.set(opId, remoteSha);
  }

  async listKnownOperationIds() {
    return Array.from(this.stored.keys()).concat(
      this.outbox.map((operation) => operation.opId),
    );
  }

  async listQuarantinedOperationIds() {
    return Array.from(this.quarantined);
  }

  async quarantineRemoteOperation(operation: QuarantinedRemoteOperation) {
    this.events.push(`quarantine:${operation.opId}`);
    this.quarantined.add(operation.opId);
  }

  async storeRemoteOperation(operation: RemoteOperationEnvelope) {
    this.events.push(`store:${operation.opId}`);
    this.stored.set(operation.opId, operation.envelope);
    this.remoteDevices.set(operation.opId, operation.deviceId);
  }

  async listStoredEnvelopes(): Promise<StoredOperationEnvelope[]> {
    const values = new Map(this.stored);
    for (const operation of this.outbox) {
      values.set(operation.opId, operation.envelope);
    }
    return Array.from(values, ([opId, envelope]) => ({ opId, envelope }));
  }
}

class FakeOperationStore implements SyncEngineOperationStore {
  events: string[] = [];
  files: RemoteOperationFile[] = [];
  envelopes = new Map<string, string>();
  buffered = new Map<string, { deviceId: string; opId: string }>();
  flushFailure?: Error;
  flushReceipts?: FlushReceipt[];

  async upload(deviceId: string, opId: string) {
    this.events.push(`upload:${opId}`);
    this.buffered.set(opId, { deviceId, opId });
    return "created" as const;
  }

  async flushUploads() {
    this.events.push("flush");
    if (this.flushFailure) {
      throw this.flushFailure;
    }
    if (this.flushReceipts) {
      this.buffered.clear();
      return this.flushReceipts;
    }
    const receipts = Array.from(this.buffered.values());
    this.buffered.clear();
    return receipts;
  }

  async listOperationFiles() {
    this.events.push("list");
    return this.files;
  }

  async download(deviceId: string, opId: string) {
    this.events.push(`download:${opId}`);
    const envelope = this.envelopes.get(`${deviceId}:${opId}`);
    if (!envelope) {
      throw new Error("missing envelope");
    }
    return envelope;
  }
}

class FakeLocalAdapter implements SyncEngineLocalAdapter {
  applied: DerivedSyncState[] = [];
  unlocked = true;
  seedComplete = true;
  materialized?: { opId: string; envelope: string };
  missingIntentIds = new Set<string>();
  beforeApply?: () => void;

  async isUnlocked() {
    return this.unlocked;
  }

  async materializeIntent(intent: SyncMutationIntent) {
    if (this.missingIntentIds.has(intent.intentId)) {
      throw new DirtyIntentAccountMissingError(intent.intentId);
    }
    if (!this.materialized) {
      throw new Error("Unexpected dirty intent");
    }
    return this.materialized;
  }

  async ensureSeeded() {
    return this.seedComplete;
  }

  async applyDerivedState(
    state: DerivedSyncState,
    isCurrent: () => Promise<boolean>,
    afterApply: () => Promise<void>,
  ) {
    this.beforeApply?.();
    if (!(await isCurrent())) {
      return false;
    }
    this.applied.push(state);
    await afterApply();
    return true;
  }
}

async function remoteOperation(
  opId: string,
  overrides: Partial<{
    deviceId: string;
    parents: string[];
    secret: string;
  }> = {},
) {
  return createOperation({
    formatVersion: 1,
    repositoryId,
    opId,
    deviceId: overrides.deviceId || remoteDeviceId,
    entityType: "otp",
    entityId,
    kind: "upsert",
    parents: overrides.parents || [],
    createdAt: 1,
    payload: {
      type: "totp",
      secret: overrides.secret || "fixture-value",
    },
  });
}

function createEngine(
  session: Omit<SyncRepositorySession, "initialized"> & {
    initialized?: boolean;
  },
  journal: FakeJournal,
  remote: FakeOperationStore,
  local: FakeLocalAdapter,
): SyncRunner {
  const resolvedSession: SyncRepositorySession = {
    initialized: true,
    ...session,
  };
  return new SyncEngine(
    {
      async getSession() {
        return resolvedSession;
      },
    },
    journal,
    remote,
    local,
    localDeviceId,
  );
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

describe("SyncEngine", () => {
  it("uploads and acknowledges fixed outbox bytes before requiring a sync password", async () => {
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      deviceId: localDeviceId,
      remoteAcknowledged: false,
    });
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const result = await createEngine(
      { repositoryId, mode: "aes-256-gcm" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "needsSyncPassword" });
    assert.deepEqual(remote.events, [
      "list",
      "upload:55555555-5555-4555-8555-555555555555",
      "flush",
    ]);
    assert.deepEqual(journal.events, [
      "ack:55555555-5555-4555-8555-555555555555",
    ]);
  });

  it("materializes and uploads dirty intents after the repository key returns", async () => {
    const journal = new FakeJournal();
    journal.dirtyIntents.push({
      intentId: "intent-dirty",
      repositoryId,
      entityType: "otp",
      entityId,
      kind: "upsert",
      parents: [],
      createdAt: 1,
      localApplied: true,
    });
    const operation = await createOperation({
      formatVersion: 1,
      repositoryId,
      opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      deviceId: localDeviceId,
      entityType: "otp",
      entityId,
      kind: "upsert",
      parents: [],
      createdAt: 1,
      payload: { type: "totp", secret: "dirty-fixture-value" },
    });
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    local.materialized = {
      opId: operation.opId,
      envelope: await createOperationEnvelope(
        operation,
        "aes-256-gcm",
        bytes(4),
        new Uint8Array(12).fill(5),
      ),
    };

    const result = await createEngine(
      { repositoryId, mode: "aes-256-gcm", dataKey: bytes(4) },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "synced" });
    assert.deepEqual(remote.events, [
      "list",
      `upload:${operation.opId}`,
      "flush",
    ]);
    assert.deepEqual(journal.events, [
      "materialize:intent-dirty",
      `ack:${operation.opId}`,
    ]);
  });

  it("coalesces a dirty upsert that was superseded by a later delete", async () => {
    const journal = new FakeJournal();
    journal.dirtyIntents.push(
      {
        intentId: "intent-edit",
        repositoryId,
        entityType: "otp",
        entityId,
        kind: "upsert",
        parents: [],
        createdAt: 1,
        localApplied: true,
      },
      {
        intentId: "intent-delete",
        repositoryId,
        entityType: "otp",
        entityId,
        kind: "delete",
        parents: [],
        createdAt: 2,
        localApplied: true,
      },
    );
    const deletion = await createOperation({
      formatVersion: 1,
      repositoryId,
      opId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      deviceId: localDeviceId,
      entityType: "otp",
      entityId,
      kind: "delete",
      parents: [],
      createdAt: 2,
      payload: null,
    });
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    local.missingIntentIds.add("intent-edit");
    local.materialized = {
      opId: deletion.opId,
      envelope: await createOperationEnvelope(deletion, "none"),
    };

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "synced" });
    assert.include(journal.events, "supersede:intent-edit:intent-delete");
    assert.include(journal.events, "materialize:intent-delete");
  });

  it("does not acknowledge buffered operations when the flush fails", async () => {
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      deviceId: localDeviceId,
      remoteAcknowledged: false,
    });
    const remote = new FakeOperationStore();
    remote.flushFailure = new Error("flush failed");
    const local = new FakeLocalAdapter();

    await assertRejects(
      createEngine(
        { repositoryId, mode: "aes-256-gcm" },
        journal,
        remote,
        local,
      ).run([]),
    );

    assert.deepEqual(remote.events, [
      "list",
      "upload:55555555-5555-4555-8555-555555555555",
      "flush",
    ]);
    assert.deepEqual(journal.events, []);
  });

  it("acknowledges only the operations confirmed by the flush receipts", async () => {
    const journal = new FakeJournal();
    const received = "55555555-5555-4555-8555-555555555555";
    const unconfirmed = "55555555-5555-4555-8555-555555555556";
    journal.outbox.push(
      {
        opId: received,
        intentId: "intent-1",
        repositoryId,
        envelope: "fixed-encrypted-envelope-a",
        deviceId: localDeviceId,
        remoteAcknowledged: false,
      },
      {
        opId: unconfirmed,
        intentId: "intent-2",
        repositoryId,
        envelope: "fixed-encrypted-envelope-b",
        deviceId: localDeviceId,
        remoteAcknowledged: false,
      },
    );
    const remote = new FakeOperationStore();
    remote.flushReceipts = [{ deviceId: localDeviceId, opId: received }];
    const local = new FakeLocalAdapter();

    const result = await createEngine(
      { repositoryId, mode: "aes-256-gcm" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "needsSyncPassword" });
    assert.deepEqual(journal.events, [`ack:${received}`]);
  });

  it("fails closed without writing when a durable operation is missing remotely", async () => {
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      remoteAcknowledged: true,
    });
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();

    await assertRejects(
      createEngine(
        { repositoryId, mode: "aes-256-gcm" },
        journal,
        remote,
        local,
      ).run([]),
    );

    assert.deepEqual(remote.events, ["list"]);
    assert.deepEqual(journal.events, []);
  });

  it("fails closed without writing when a durable operation changed content address", async () => {
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      deviceId: localDeviceId,
      remoteAcknowledged: true,
      remoteSha: "old-sha",
    });
    const remote = new FakeOperationStore();
    remote.files = [
      {
        deviceId: localDeviceId,
        opId: "55555555-5555-4555-8555-555555555555",
        sha: "new-sha",
      },
    ];
    const local = new FakeLocalAdapter();

    await assertRejects(
      createEngine(
        { repositoryId, mode: "aes-256-gcm" },
        journal,
        remote,
        local,
      ).run([]),
    );

    assert.deepEqual(remote.events, ["list"]);
    assert.deepEqual(journal.events, []);
  });

  it("recovers a legacy local operation after the device id was regenerated", async () => {
    const journal = new FakeJournal();
    const operation = await remoteOperation(
      "abababab-abab-4bab-8bab-abababababab",
    );
    const envelope = await createOperationEnvelope(
      operation,
      "aes-256-gcm",
      bytes(4),
      new Uint8Array(12).fill(8),
    );
    journal.outbox.push({
      opId: operation.opId,
      intentId: "intent-legacy-device",
      repositoryId,
      envelope,
      remoteAcknowledged: true,
      remoteSha: "remote-sha",
    });
    const remote = new FakeOperationStore();
    remote.files = [
      {
        deviceId: remoteDeviceId,
        opId: operation.opId,
        sha: "remote-sha",
      },
    ];
    const local = new FakeLocalAdapter();

    const result = await createEngine(
      { repositoryId, mode: "aes-256-gcm", dataKey: bytes(4) },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "synced" });
    assert.equal(journal.outbox[0].deviceId, remoteDeviceId);
    assert.include(journal.events, `attachDevice:${operation.opId}`);
  });

  it("still fails closed when a device-bound operation moved remotely", async () => {
    const journal = new FakeJournal();
    const operation = await remoteOperation(
      "acacacac-acac-4cac-8cac-acacacacacac",
    );
    const envelope = await createOperationEnvelope(operation, "none");
    journal.outbox.push({
      opId: operation.opId,
      intentId: "intent-device-bound",
      repositoryId,
      envelope,
      deviceId: remoteDeviceId,
      remoteAcknowledged: true,
      remoteSha: "remote-sha",
    });
    const remote = new FakeOperationStore();
    remote.files = [
      {
        deviceId: secondRemoteDeviceId,
        opId: operation.opId,
        sha: "remote-sha",
      },
    ];

    await assertRejects(
      createEngine(
        { repositoryId, mode: "none" },
        journal,
        remote,
        new FakeLocalAdapter(),
      ).run([]),
    );

    assert.notInclude(journal.events, `attachDevice:${operation.opId}`);
    assert.deepEqual(remote.events, ["list"]);
  });

  it("bootstraps a legacy no-sha durable operation before permitting writes", async () => {
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      deviceId: localDeviceId,
      remoteAcknowledged: true,
    });
    const remote = new FakeOperationStore();
    remote.files = [
      {
        deviceId: localDeviceId,
        opId: "55555555-5555-4555-8555-555555555555",
        sha: "remote-sha",
      },
    ];
    remote.envelopes.set(
      `${localDeviceId}:55555555-5555-4555-8555-555555555555`,
      "fixed-encrypted-envelope",
    );
    const local = new FakeLocalAdapter();

    const result = await createEngine(
      { repositoryId, mode: "aes-256-gcm" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "needsSyncPassword" });
    assert.deepEqual(journal.events, [
      "attachSha:55555555-5555-4555-8555-555555555555",
    ]);
    assert.deepEqual(remote.events, [
      "list",
      "download:55555555-5555-4555-8555-555555555555",
    ]);
  });

  it("downloads, validates, stores, reduces, and applies unknown operations", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const operation = await remoteOperation(
      "66666666-6666-4666-8666-666666666666",
    );
    const envelope = await createOperationEnvelope(operation, "none");
    remote.files = [{ deviceId: remoteDeviceId, opId: operation.opId }];
    remote.envelopes.set(`${remoteDeviceId}:${operation.opId}`, envelope);

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "synced" });
    assert.deepEqual(remote.events, ["list", `download:${operation.opId}`]);
    assert.deepEqual(journal.events, [`store:${operation.opId}`]);
    assert.equal(local.applied[0].entries[0].payload.secret, "fixture-value");
  });

  it("quarantines an operation whose authenticated device differs from its path", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const operation = await remoteOperation(
      "77777777-7777-4777-8777-777777777777",
      { deviceId: localDeviceId },
    );
    remote.files = [{ deviceId: remoteDeviceId, opId: operation.opId }];
    remote.envelopes.set(
      `${remoteDeviceId}:${operation.opId}`,
      await createOperationEnvelope(operation, "none"),
    );

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "remoteCorrupt" });
    assert.deepEqual(journal.events, [`quarantine:${operation.opId}`]);
    assert.deepEqual(local.applied, []);
  });

  it("continues applying healthy operations while a corrupt file is quarantined", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const healthy = await remoteOperation(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    );
    const corruptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    remote.files = [
      { deviceId: remoteDeviceId, opId: healthy.opId },
      { deviceId: secondRemoteDeviceId, opId: corruptId },
    ];
    remote.envelopes.set(
      `${remoteDeviceId}:${healthy.opId}`,
      await createOperationEnvelope(healthy, "none"),
    );
    remote.envelopes.set(
      `${secondRemoteDeviceId}:${corruptId}`,
      "not-an-envelope",
    );

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "remoteCorrupt" });
    assert.equal(local.applied[0].entries[0].id, entityId);
    assert.include(journal.events, `store:${healthy.opId}`);
    assert.include(journal.events, `quarantine:${corruptId}`);
  });

  it("does not replace local state when a mutation enters the journal before apply", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const operation = await remoteOperation(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    const envelope = await createOperationEnvelope(operation, "none");
    journal.stored.set(operation.opId, envelope);
    journal.remoteDevices.set(operation.opId, remoteDeviceId);
    // The operation is already durably present on the remote branch so the
    // fail-closed history check passes; only the local apply-time mutation
    // is new.
    remote.files = [
      { deviceId: remoteDeviceId, opId: operation.opId, sha: "remote-sha" },
    ];
    remote.envelopes.set(`${remoteDeviceId}:${operation.opId}`, envelope);
    local.beforeApply = () => {
      journal.stored.set("new-local-operation", "new-envelope");
    };

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "pending" });
    assert.deepEqual(local.applied, []);
  });

  it("does not apply a graph with missing causal dependencies", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const operation = await remoteOperation(
      "88888888-8888-4888-8888-888888888888",
      { parents: ["99999999-9999-4999-8999-999999999999"] },
    );
    remote.files = [{ deviceId: remoteDeviceId, opId: operation.opId }];
    remote.envelopes.set(
      `${remoteDeviceId}:${operation.opId}`,
      await createOperationEnvelope(operation, "none"),
    );

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "remoteIncomplete" });
    assert.deepEqual(local.applied, []);
  });

  it("applies a deterministic temporary branch while reporting conflicts", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    const first = await remoteOperation(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      { secret: "first-fixture-value" },
    );
    const second = await remoteOperation(
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      {
        deviceId: secondRemoteDeviceId,
        secret: "second-fixture-value",
      },
    );
    remote.files = [
      { deviceId: remoteDeviceId, opId: first.opId },
      { deviceId: secondRemoteDeviceId, opId: second.opId },
    ];
    remote.envelopes.set(
      `${remoteDeviceId}:${first.opId}`,
      await createOperationEnvelope(first, "none"),
    );
    remote.envelopes.set(
      `${secondRemoteDeviceId}:${second.opId}`,
      await createOperationEnvelope(second, "none"),
    );

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "conflict" });
    assert.lengthOf(local.applied, 1);
    assert.lengthOf(local.applied[0].conflicts, 1);
  });

  it("verifies seed completeness before replacing local state", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    local.seedComplete = false;

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "initializing" });
    assert.deepEqual(local.applied, []);
  });

  it("does not merge remote state before first-connect seeding completes", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();

    const result = await createEngine(
      { repositoryId, mode: "none", initialized: false },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "initializing" });
    assert.deepEqual(local.applied, []);
  });

  it("defers pull and apply while local accounts are locked", async () => {
    const journal = new FakeJournal();
    const remote = new FakeOperationStore();
    const local = new FakeLocalAdapter();
    local.unlocked = false;

    const result = await createEngine(
      { repositoryId, mode: "none" },
      journal,
      remote,
      local,
    ).run([]);

    assert.deepEqual(result, { status: "needsLocalUnlock" });
    assert.deepEqual(remote.events, ["list"]);
  });
});
