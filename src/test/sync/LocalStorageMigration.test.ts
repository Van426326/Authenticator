import "mocha";
import { assert } from "chai";

import {
  AccountStorageLocation,
  AsyncStorageArea,
  LocalAccountStorageMigration,
  ManagedSyncStorageError,
  StorageMigrationConflictError,
} from "../../sync/LocalStorageMigration";

mocha.setup("bdd");

class FakeStorageArea implements AsyncStorageArea {
  readonly events: string[];
  corruptWrites = false;

  constructor(
    private data: Record<string, unknown>,
    private readonly name: string,
    events: string[],
  ) {
    this.events = events;
  }

  async get(keys?: string | string[] | null) {
    if (keys === undefined || keys === null) {
      return structuredClone(this.data);
    }
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      selected
        .filter((key) => Object.prototype.hasOwnProperty.call(this.data, key))
        .map((key) => [key, structuredClone(this.data[key])]),
    );
  }

  async set(items: Record<string, unknown>) {
    this.events.push(`${this.name}:set`);
    this.data = { ...this.data, ...structuredClone(items) };
    if (this.corruptWrites) {
      const firstKey = Object.keys(items)[0];
      if (firstKey) {
        this.data[firstKey] = { corrupted: true };
      }
    }
  }

  async remove(keys: string | string[]) {
    this.events.push(`${this.name}:remove`);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete this.data[key];
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }
}

class FakeLocation implements AccountStorageLocation {
  isLocal = false;
  failSetLocal = false;

  constructor(private readonly events: string[]) {}

  async usesLocalStorage() {
    return this.isLocal;
  }

  async setLocalStorage() {
    this.events.push("location:local");
    if (this.failSetLocal) {
      throw new Error("settings write failed");
    }
    this.isLocal = true;
  }
}

function createMigration(
  syncStorage: AsyncStorageArea,
  localStorage: AsyncStorageArea,
  location: AccountStorageLocation,
  isSyncStorageForced = false,
) {
  return new LocalAccountStorageMigration({
    syncStorage,
    localStorage,
    location,
    policy: {
      async isSyncStorageForced() {
        return isSyncStorageForced;
      },
    },
  });
}

describe("LocalAccountStorageMigration", () => {
  it("copies and verifies accounts before switching location and removing source", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea(
      {
        account1: { dataType: "OTPStorage", secret: "fixture-value" },
        encryptionKey: { dataType: "Key", hash: "fixture-hash" },
        UserSettings: { theme: "dark" },
      },
      "sync",
      events,
    );
    const local = new FakeStorageArea(
      { UserSettings: { storageLocation: "sync", autolock: 5 } },
      "local",
      events,
    );
    const location = new FakeLocation(events);
    const migration = createMigration(sync, local, location);

    const result = await migration.migrate();

    assert.deepEqual(result, { copiedKeys: ["account1", "encryptionKey"] });
    assert.deepEqual(events, ["local:set", "location:local", "sync:remove"]);
    assert.deepInclude(local.snapshot(), {
      account1: { dataType: "OTPStorage", secret: "fixture-value" },
      encryptionKey: { dataType: "Key", hash: "fixture-hash" },
      UserSettings: { storageLocation: "sync", autolock: 5 },
    });
    assert.deepEqual(sync.snapshot(), { UserSettings: { theme: "dark" } });
  });

  it("refuses to overwrite different persisted local data", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea(
      { account1: { issuer: "source" } },
      "sync",
      events,
    );
    const local = new FakeStorageArea(
      { account1: { issuer: "target" } },
      "local",
      events,
    );
    const location = new FakeLocation(events);

    let error: unknown;
    try {
      await createMigration(sync, local, location).migrate();
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, StorageMigrationConflictError);
    assert.deepEqual(events, []);
    assert.deepEqual(sync.snapshot(), { account1: { issuer: "source" } });
    assert.deepEqual(local.snapshot(), { account1: { issuer: "target" } });
  });

  it("keeps the source when verification fails", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea(
      { account1: { issuer: "source" } },
      "sync",
      events,
    );
    const local = new FakeStorageArea({}, "local", events);
    local.corruptWrites = true;
    const location = new FakeLocation(events);

    let rejected = false;
    try {
      await createMigration(sync, local, location).migrate();
    } catch {
      rejected = true;
    }

    assert.isTrue(rejected);
    assert.isFalse(location.isLocal);
    assert.deepEqual(events, ["local:set"]);
    assert.deepEqual(sync.snapshot(), { account1: { issuer: "source" } });
  });

  it("keeps the source when switching settings fails", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea(
      { account1: { issuer: "source" } },
      "sync",
      events,
    );
    const local = new FakeStorageArea({}, "local", events);
    const location = new FakeLocation(events);
    location.failSetLocal = true;

    let rejected = false;
    try {
      await createMigration(sync, local, location).migrate();
    } catch {
      rejected = true;
    }

    assert.isTrue(rejected);
    assert.deepEqual(events, ["local:set", "location:local"]);
    assert.deepEqual(sync.snapshot(), { account1: { issuer: "source" } });
    assert.deepEqual(local.snapshot(), { account1: { issuer: "source" } });
  });

  it("removes a matching residual sync copy after a previous partial migration", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea({ account1: {} }, "sync", events);
    const local = new FakeStorageArea({ account1: {} }, "local", events);
    const location = new FakeLocation(events);
    location.isLocal = true;

    const result = await createMigration(sync, local, location).migrate();

    assert.deepEqual(result, { copiedKeys: [] });
    assert.deepEqual(events, ["sync:remove"]);
    assert.deepEqual(sync.snapshot(), {});
  });

  it("refuses residual cleanup when the local copy is missing", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea({ account1: {} }, "sync", events);
    const local = new FakeStorageArea({}, "local", events);
    const location = new FakeLocation(events);
    location.isLocal = true;

    let error: unknown;
    try {
      await createMigration(sync, local, location).migrate();
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, StorageMigrationConflictError);
    assert.deepEqual(events, []);
    assert.deepEqual(sync.snapshot(), { account1: {} });
  });

  it("rejects migration when managed policy forces sync storage", async () => {
    const events: string[] = [];
    const sync = new FakeStorageArea({ account1: {} }, "sync", events);
    const local = new FakeStorageArea({}, "local", events);
    const location = new FakeLocation(events);

    let error: unknown;
    try {
      await createMigration(sync, local, location, true).migrate();
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, ManagedSyncStorageError);
    assert.deepEqual(events, []);
  });
});
