import { assert } from "chai";
import { Encryption } from "../../models/encryption";
import { OTPEntry, OTPType } from "../../models/otp";
import { AsyncMutex } from "../../sync/AsyncMutex";
import {
  AuthenticatorLocalAccountAdapter,
  LocalEncryptionProvider,
  LocalEntryStore,
  SeedMutationWriter,
} from "../../sync/LocalAccountAdapter";
import { AccountMutation } from "../../sync/SyncCoordinator";
import {
  createOperation,
  createOperationEnvelope,
  openOperationEnvelope,
} from "../../sync/SyncCrypto";
import { SyncMutationIntent } from "../../sync/SyncJournal";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const entityId = "33333333-3333-4333-8333-333333333333";
const secondEntityId = "44444444-4444-4444-8444-444444444444";

class MemoryEntryStore implements LocalEntryStore {
  entries: OTPEntry[] = [];
  encrypted = false;

  async get() {
    return this.entries.map((entry) => entry);
  }

  async replace(entries: OTPEntry[]) {
    this.entries = entries;
  }

  async hasEncryptionKey() {
    return this.encrypted;
  }
}

class MemorySeedWriter implements SeedMutationWriter {
  mutations: AccountMutation[] = [];

  async mutate(mutation: AccountMutation) {
    this.mutations.push(mutation);
  }
}

const unlockedProvider: LocalEncryptionProvider = {
  async getEncryption() {
    return undefined;
  },
};

function localEntry(id = entityId, secret = "JBSWY3DPEHPK3PXP", index = 0) {
  return new OTPEntry({
    encrypted: false,
    hash: id,
    index,
    secret,
    type: OTPType.totp,
  });
}

function intent(
  kind: SyncMutationIntent["kind"] = "upsert",
): SyncMutationIntent {
  return {
    intentId: "55555555-5555-4555-8555-555555555555",
    repositoryId,
    entityType: "otp",
    entityId,
    kind,
    parents: [],
    createdAt: 10,
    localApplied: false,
  };
}

describe("AuthenticatorLocalAccountAdapter", () => {
  it("applies an upsert through the shared mutex permit", async () => {
    const storage = new MemoryEntryStore();
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      undefined,
      undefined,
      deviceId,
    );
    const mutex = new AsyncMutex();

    await mutex.runExclusive((permit) =>
      adapter.applyMutation(
        {
          intent: intent(),
          logicalPayload: {
            type: "totp",
            secret: "JBSWY3DPEHPK3PXP",
            issuer: "Example",
          },
        },
        permit,
      ),
    );

    assert.equal(storage.entries.length, 1);
    assert.equal(storage.entries[0].hash, entityId);
    assert.equal(storage.entries[0].secret, "JBSWY3DPEHPK3PXP");
    assert.equal(storage.entries[0].issuer, "Example");
  });

  it("replaces local state from the derived remote state without retaining stale entries", async () => {
    const storage = new MemoryEntryStore();
    storage.entries = [
      localEntry(entityId),
      localEntry(secondEntityId, "AAAA", 1),
    ];
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      undefined,
      undefined,
      deviceId,
    );
    const source = await createOperation({
      formatVersion: 1,
      opId: "66666666-6666-4666-8666-666666666666",
      repositoryId,
      deviceId,
      entityType: "otp",
      entityId: secondEntityId,
      kind: "upsert",
      parents: [],
      createdAt: 1,
      payload: { type: "totp", secret: "BBBB" },
    });

    await adapter.applyDerivedState(
      {
        entries: [
          {
            id: secondEntityId,
            payload: { type: "totp", secret: "BBBB" },
            source,
            conflicts: [],
          },
        ],
        order: [secondEntityId],
        conflicts: [],
        pending: [],
      },
      async () => true,
      async () => undefined,
    );

    assert.deepEqual(
      storage.entries.map((entry) => entry.hash),
      [secondEntityId],
    );
    assert.equal(storage.entries[0].secret, "BBBB");
  });

  it("materializes a dirty intent from the current logical account", async () => {
    const storage = new MemoryEntryStore();
    storage.entries = [localEntry()];
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      undefined,
      undefined,
      deviceId,
    );

    const materialized = await adapter.materializeIntent(intent(), {
      repositoryId,
      mode: "none",
      initialized: true,
    });
    const operation = await openOperationEnvelope(
      materialized.envelope,
      "none",
    );

    assert.equal(operation.opId, materialized.opId);
    assert.equal(operation.deviceId, deviceId);
    assert.equal(operation.entityId, entityId);
    assert.deepEqual(operation.payload, {
      type: "totp",
      secret: "JBSWY3DPEHPK3PXP",
    });
  });

  it("creates root account and order mutations for first-connect local data", async () => {
    const storage = new MemoryEntryStore();
    storage.entries = [localEntry()];
    const writer = new MemorySeedWriter();
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      writer,
      undefined,
      deviceId,
    );

    const complete = await adapter.ensureSeeded([], {
      repositoryId,
      mode: "none",
      initialized: true,
    });

    assert.isFalse(complete);
    assert.equal(writer.mutations.length, 2);
    assert.deepInclude(writer.mutations[0].intent, {
      entityType: "otp",
      entityId,
      parents: [],
    });
    assert.deepInclude(writer.mutations[1].intent, {
      entityType: "order",
      entityId: "global-order",
      parents: [],
    });
    assert.deepEqual(writer.mutations[1].logicalPayload, { ids: [entityId] });
  });

  it("adopts matching remote history without creating duplicate roots", async () => {
    const storage = new MemoryEntryStore();
    storage.entries = [localEntry()];
    const writer = new MemorySeedWriter();
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      writer,
      undefined,
      deviceId,
    );
    const account = await createOperation({
      formatVersion: 1,
      opId: "77777777-7777-4777-8777-777777777777",
      repositoryId,
      deviceId,
      entityType: "otp",
      entityId,
      kind: "upsert",
      parents: [],
      createdAt: 1,
      payload: { type: "totp", secret: "JBSWY3DPEHPK3PXP" },
    });
    const order = await createOperation({
      formatVersion: 1,
      opId: "88888888-8888-4888-8888-888888888888",
      repositoryId,
      deviceId,
      entityType: "order",
      entityId: "global-order",
      kind: "upsert",
      parents: [],
      createdAt: 2,
      payload: { ids: [entityId] },
    });

    assert.isTrue(
      await adapter.ensureSeeded([account, order], {
        repositoryId,
        mode: "none",
        initialized: true,
      }),
    );
    assert.deepEqual(writer.mutations, []);
  });

  it("defers crash recovery while local accounts are locked", async () => {
    const storage = new MemoryEntryStore();
    storage.encrypted = true;
    const dataKey = new Uint8Array(32).fill(9);
    const operation = await createOperation({
      formatVersion: 1,
      opId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      repositoryId,
      deviceId,
      entityType: "otp",
      entityId,
      kind: "upsert",
      parents: [],
      createdAt: 10,
      payload: { type: "totp", secret: "AAAA" },
    });
    const envelope = await createOperationEnvelope(
      operation,
      "aes-256-gcm",
      dataKey,
      new Uint8Array(12).fill(3),
    );
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      unlockedProvider,
      undefined,
      {
        async getSession() {
          return {
            repositoryId,
            mode: "aes-256-gcm" as const,
            initialized: true,
            dataKey,
          };
        },
      },
      deviceId,
    );
    const mutex = new AsyncMutex();

    const recovered = await mutex.runExclusive((permit) =>
      adapter.recoverIntent(
        intent(),
        { opId: operation.opId, envelope },
        permit,
      ),
    );

    assert.isFalse(recovered);
    assert.deepEqual(storage.entries, []);
  });

  it("preserves local encryption when applying remote state", async () => {
    const storage = new MemoryEntryStore();
    storage.encrypted = true;
    const provider: LocalEncryptionProvider = {
      async getEncryption() {
        return new Encryption("local-key", "key-id");
      },
    };
    const adapter = new AuthenticatorLocalAccountAdapter(
      storage,
      provider,
      undefined,
      undefined,
      deviceId,
    );
    const source = await createOperation({
      formatVersion: 1,
      opId: "99999999-9999-4999-8999-999999999999",
      repositoryId,
      deviceId,
      entityType: "otp",
      entityId,
      kind: "upsert",
      parents: [],
      createdAt: 1,
      payload: { type: "totp", secret: "JBSWY3DPEHPK3PXP" },
    });

    await adapter.applyDerivedState(
      {
        entries: [
          {
            id: entityId,
            payload: { type: "totp", secret: "JBSWY3DPEHPK3PXP" },
            source,
            conflicts: [],
          },
        ],
        order: [entityId],
        conflicts: [],
        pending: [],
      },
      async () => true,
      async () => undefined,
    );

    assert.isTrue(storage.entries[0].encryption?.getEncryptionStatus());
    assert.equal(storage.entries[0].encryption?.getEncryptionKeyId(), "key-id");
  });
});
