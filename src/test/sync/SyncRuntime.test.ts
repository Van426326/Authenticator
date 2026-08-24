import "mocha";
import { assert } from "chai";

import { gitBlobSha } from "../../sync/github/GitBlobSha";
import { GitHubRepositoryIdentityChangedError } from "../../sync/github/GitHubRepository";
import { RemoteHistoryRewrittenError } from "../../sync/SyncEngineTypes";
import {
  createEncryptedRepositoryConfig,
  repositoryConfigFingerprint,
  serializeRepositoryConfig,
} from "../../sync/RepositoryConfig";
import { encodeBase64 } from "../../sync/Base64";
import { DerivedSyncState } from "../../sync/SyncState";
import { SyncMutationIntent } from "../../sync/SyncJournal";
import {
  DirtyIntentAccountMissingError,
  MaterializedSyncIntent,
  SyncEngineJournal,
  SyncEngineLocalAdapter,
  SyncRepositorySession,
} from "../../sync/SyncEngine";
import {
  ChromeGitHubConnectionStore,
  ChromeGitHubSessionKeyStore,
  ChromeGitHubTokenStore,
  ChromeSyncStatusReporter,
  ConfiguredGitHubSyncRunner,
  createBackgroundSyncRuntime,
  GitHubSyncDetails,
  StoredSyncStatus,
  SyncLocalStorage,
  SyncPermissionChecker,
  SyncSessionStorage,
  SyncStatusBroadcaster,
} from "../../sync/SyncRuntime";
import {
  OutboxOperation,
  QuarantinedRemoteOperation,
  RemoteOperationEnvelope,
  StoredOperationEnvelope,
} from "../../sync/SyncJournal";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const owner = "alice";
const repositoryName = "auth-sync";
const branch = "authenticator-sync";
const token = "fake-token-not-a-real-pat";

const PREFIX = `https://api.github.com/repos/${owner}/${repositoryName}`;
const REPO_URL = PREFIX;
const DEFAULT_REF_URL = `${PREFIX}/git/ref/heads%2Fmain`;
const SYNC_REF_URL = `${PREFIX}/git/ref/heads%2F${branch}`;
const commitUrl = (sha: string) => `${PREFIX}/git/commits/${sha}`;
const treeUrl = (sha: string) => `${PREFIX}/git/trees/${sha}`;
const blobUrl = (sha: string) => `${PREFIX}/git/blobs/${sha}`;

const headSha = "1".repeat(40);
const defaultHead = "2".repeat(40);
const headTreeSha = "3".repeat(40);
const asTreeSha = "4".repeat(40);

const kdf = {
  name: "argon2id" as const,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  time: 2,
  memoryKiB: 19456,
  parallelism: 1,
  hashLength: 32,
};

function bytes(value: number) {
  return new Uint8Array(32).fill(value);
}

class MemoryLocalStorage implements SyncLocalStorage {
  values: Record<string, unknown> = {};

  async get(key: string) {
    return { [key]: this.values[key] };
  }

  async set(values: Record<string, unknown>) {
    Object.assign(this.values, values);
  }

  async remove(key: string) {
    delete this.values[key];
  }
}

class MemorySessionStorage implements SyncSessionStorage {
  values: Record<string, unknown> = {};

  async get(key: string) {
    return { [key]: this.values[key] };
  }

  async set(values: Record<string, unknown>) {
    Object.assign(this.values, values);
  }

  async remove(key: string) {
    delete this.values[key];
  }
}

class MemoryBroadcaster implements SyncStatusBroadcaster {
  statuses: StoredSyncStatus[] = [];

  async broadcast(status: StoredSyncStatus) {
    this.statuses.push(status);
  }
}

class AlwaysPermission implements SyncPermissionChecker {
  async containsOrigin() {
    return true;
  }
}

class NeverPermission implements SyncPermissionChecker {
  async containsOrigin() {
    return false;
  }
}

interface ScriptStep {
  method: string;
  url: string;
  response: Response | Error;
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function blobResponse(bytesValue: Uint8Array, sha: string) {
  return jsonResponse({
    sha,
    encoding: "base64",
    content: encodeBase64(bytesValue),
    size: bytesValue.byteLength,
  });
}

function scriptedFetch(steps: ScriptStep[]) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const index = steps.findIndex(
      (step) => step.method === method && step.url === url,
    );
    if (index === -1) {
      throw new Error(`Unexpected ${method} ${url}`);
    }
    const [step] = steps.splice(index, 1);
    if (step.response instanceof Error) {
      throw step.response;
    }
    return step.response;
  };
}

async function withGlobalScriptedFetch<T>(
  steps: ScriptStep[],
  operation: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const handle = scriptedFetch(steps);
  globalThis.fetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    return handle(input, init ?? {});
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

async function encryptedFixture() {
  const encrypted = await createEncryptedRepositoryConfig(kdf, bytes(4), {
    repositoryId,
    createdAt: 123,
    dataKey: bytes(7),
    nonce: new Uint8Array(12).fill(9),
  });
  const serialized = serializeRepositoryConfig(encrypted.config);
  const bytesValue = new TextEncoder().encode(serialized);
  const sha = await gitBlobSha(bytesValue);
  const fingerprint = await repositoryConfigFingerprint(encrypted.config);
  return {
    config: encrypted.config,
    bytes: bytesValue,
    sha,
    fingerprint,
  };
}

function inspectSteps(
  fixture: Awaited<ReturnType<typeof encryptedFixture>>,
): ScriptStep[] {
  return [
    {
      method: "GET",
      url: REPO_URL,
      response: jsonResponse({
        private: true,
        default_branch: "main",
        permissions: { pull: true, push: true },
      }),
    },
    {
      method: "GET",
      url: DEFAULT_REF_URL,
      response: jsonResponse({ object: { type: "commit", sha: defaultHead } }),
    },
    {
      method: "GET",
      url: SYNC_REF_URL,
      response: jsonResponse({ object: { type: "commit", sha: headSha } }),
    },
    {
      method: "GET",
      url: commitUrl(headSha),
      response: jsonResponse({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: defaultHead }],
      }),
    },
    {
      method: "GET",
      url: treeUrl(headTreeSha),
      response: jsonResponse({
        sha: headTreeSha,
        truncated: false,
        tree: [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ],
      }),
    },
    {
      method: "GET",
      url: treeUrl(asTreeSha),
      response: jsonResponse({
        sha: asTreeSha,
        truncated: false,
        tree: [
          {
            path: "config.json",
            mode: "100644",
            type: "blob",
            sha: fixture.sha,
          },
        ],
      }),
    },
    {
      method: "GET",
      url: blobUrl(fixture.sha),
      response: blobResponse(fixture.bytes, fixture.sha),
    },
  ];
}

function engineListSteps(): ScriptStep[] {
  return [
    {
      method: "GET",
      url: SYNC_REF_URL,
      response: jsonResponse({ object: { type: "commit", sha: headSha } }),
    },
    {
      method: "GET",
      url: commitUrl(headSha),
      response: jsonResponse({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: defaultHead }],
      }),
    },
    {
      method: "GET",
      url: `${treeUrl(headTreeSha)}?recursive=1`,
      response: jsonResponse(
        {
          sha: headTreeSha,
          truncated: false,
          tree: [
            {
              path: "AuthenticatorSync",
              mode: "040000",
              type: "tree",
              sha: asTreeSha,
            },
            {
              path: "AuthenticatorSync/config.json",
              mode: "100644",
              type: "blob",
              sha: "a".repeat(40),
            },
          ],
        },
        200,
        {
          "X-RateLimit-Remaining": "4999",
          "X-RateLimit-Reset": "1700000000",
        },
      ),
    },
  ];
}

function connectionRecord(fingerprint: string, rememberToken = false) {
  return {
    formatVersion: 1 as const,
    owner,
    repository: repositoryName,
    branch,
    repositoryId,
    fingerprint,
    mode: "aes-256-gcm" as const,
    initialized: true as const,
    rememberToken,
  };
}

class FakeJournal implements SyncEngineJournal {
  events: string[] = [];
  outbox: OutboxOperation[] = [];
  dirtyIntents: SyncMutationIntent[] = [];

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

  async markIntentSuperseded() {}

  async advanceEntityHeads() {}

  async replaceEntityHeads() {}

  async listLocalOperations() {
    return this.outbox;
  }

  async listRemoteOperations(): Promise<RemoteOperationEnvelope[]> {
    return [];
  }

  async markRemoteAcknowledged(opId: string) {
    this.events.push(`ack:${opId}`);
  }

  async attachLocalDeviceId() {}

  async attachRemoteSha() {}

  async listKnownOperationIds() {
    return [];
  }

  async listQuarantinedOperationIds() {
    return [];
  }

  async quarantineRemoteOperation(operation: QuarantinedRemoteOperation) {
    this.events.push(`quarantine:${operation.opId}`);
  }

  async storeRemoteOperation(operation: RemoteOperationEnvelope) {
    this.events.push(`store:${operation.opId}`);
  }

  async listStoredEnvelopes(): Promise<StoredOperationEnvelope[]> {
    return [];
  }
}

class FakeLocalAdapter implements SyncEngineLocalAdapter {
  unlocked = true;

  async isUnlocked() {
    return this.unlocked;
  }

  async materializeIntent(
    intent: SyncMutationIntent,
    _session: SyncRepositorySession,
  ): Promise<MaterializedSyncIntent> {
    throw new DirtyIntentAccountMissingError(intent.intentId);
  }

  async ensureSeeded() {
    return true;
  }

  async applyDerivedState(state: DerivedSyncState) {
    void state;
    return true;
  }
}

describe("SyncRuntime persistence", () => {
  it("stores GitHub identity only through the local connection store", async () => {
    const storage = new MemoryLocalStorage();
    let migrationCalls = 0;
    const connections = new ChromeGitHubConnectionStore(storage, async () => {
      migrationCalls += 1;
    });
    const record = connectionRecord("a".repeat(64));

    await connections.set(record);

    assert.deepEqual(await connections.get(), record);
    assert.equal(migrationCalls, 1);
    assert.deepEqual(Object.keys(storage.values), ["githubSyncConnection"]);
  });

  it("rejects malformed persisted connection state", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = {
      formatVersion: 1,
      owner: "alice",
    };
    const connections = new ChromeGitHubConnectionStore(storage);

    let error: unknown;
    try {
      await connections.get();
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
  });

  it("rejects a tampered stored connection whose branch is not the fixed sync branch", async () => {
    const storage = new MemoryLocalStorage();
    const tampered = {
      ...connectionRecord("a".repeat(64)),
      branch: "evil-branch",
    };
    storage.values.githubSyncConnection = tampered;
    const connections = new ChromeGitHubConnectionStore(storage);

    let error: unknown;
    try {
      await connections.get();
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);

    let setError: unknown;
    try {
      await connections.set({
        ...connectionRecord("a".repeat(64)),
        branch: "other-branch",
      });
    } catch (caught) {
      setError = caught;
    }
    assert.instanceOf(setError, Error);
    // The store refuses to persist a tampered branch and leaves stored state
    // untouched.
    assert.deepEqual(storage.values.githubSyncConnection, tampered);
  });

  it("persists and broadcasts status while retaining last success time", async () => {
    const storage = new MemoryLocalStorage();
    const broadcaster = new MemoryBroadcaster();
    let now = 10;
    const reporter = new ChromeSyncStatusReporter(
      storage,
      broadcaster,
      () => now,
    );

    await reporter.setStatus("synced");
    now = 20;
    await reporter.setStatus("offline");

    assert.deepEqual(storage.values.githubSyncStatus, {
      status: "offline",
      updatedAt: 20,
      lastSuccessfulSyncAt: 10,
    });
    assert.deepEqual(broadcaster.statuses[1], storage.values.githubSyncStatus);
  });

  it("resets stale status, details, and last-success metadata", async () => {
    const storage = new MemoryLocalStorage();
    const broadcaster = new MemoryBroadcaster();
    let now = 10;
    const reporter = new ChromeSyncStatusReporter(
      storage,
      broadcaster,
      () => now,
    );

    await reporter.setStatus("synced");
    storage.values.githubSyncDetails = {
      owner: "alice",
      repository: "auth-sync",
    };
    now = 20;
    await reporter.reset();

    assert.deepEqual(storage.values.githubSyncStatus, {
      status: "unconfigured",
      updatedAt: 20,
    });
    assert.equal(storage.values.githubSyncDetails, undefined);
    assert.deepEqual(broadcaster.statuses[broadcaster.statuses.length - 1], {
      status: "unconfigured",
      updatedAt: 20,
    });
  });

  it("loads only a bounded 32-byte repository data key from session storage", async () => {
    const storage = new MemorySessionStorage();
    storage.values.githubRepositoryDataKey = encodeBase64(bytes(7));
    const keys = new ChromeGitHubSessionKeyStore(storage);

    assert.deepEqual(await keys.getDataKey(), bytes(7));
    assert.isUndefined(
      await new ChromeGitHubSessionKeyStore(
        new MemorySessionStorage(),
      ).getDataKey(),
    );
  });

  it("persists the data key in local storage when rememberUnlock is set", async () => {
    const session = new MemorySessionStorage();
    const local = new MemoryLocalStorage();
    const keys = new ChromeGitHubSessionKeyStore(session, local);

    await keys.setDataKey(bytes(7), true);

    assert.equal(local.values.githubRepositoryDataKey, encodeBase64(bytes(7)));
    assert.equal(session.values.githubRepositoryDataKey, undefined);
    assert.deepEqual(await keys.getDataKey(), bytes(7));

    await keys.setDataKey(bytes(8), false);
    assert.equal(
      session.values.githubRepositoryDataKey,
      encodeBase64(bytes(8)),
    );
    assert.equal(local.values.githubRepositoryDataKey, undefined);
    await keys.clear();
    assert.isUndefined(await keys.getDataKey());
  });
});

describe("ChromeGitHubTokenStore", () => {
  it("keeps the PAT in session storage by default and never in local", async () => {
    const session = new MemorySessionStorage();
    const local = new MemoryLocalStorage();
    const tokens = new ChromeGitHubTokenStore(session, local);

    await tokens.setToken(token, false);

    assert.equal(session.values.githubSyncToken, token);
    assert.equal(local.values.githubSyncToken, undefined);
    assert.equal(await tokens.getToken(false), token);
  });

  it("keeps the PAT in local storage only on explicit rememberToken opt-in and clears session", async () => {
    const session = new MemorySessionStorage();
    const local = new MemoryLocalStorage();
    const tokens = new ChromeGitHubTokenStore(session, local);

    await tokens.setToken("session-token", false);
    await tokens.setToken(token, true);

    assert.equal(local.values.githubSyncToken, token);
    assert.equal(session.values.githubSyncToken, undefined);
    assert.equal(await tokens.getToken(true), token);
    assert.equal(await tokens.getToken(false), token);
  });

  it("clears the other storage area whenever the token is set", async () => {
    const session = new MemorySessionStorage();
    const local = new MemoryLocalStorage();
    const tokens = new ChromeGitHubTokenStore(session, local);
    await tokens.setToken(token, true);
    await tokens.setToken("session-token", false);
    assert.equal(session.values.githubSyncToken, "session-token");
    assert.equal(local.values.githubSyncToken, undefined);
    await tokens.setToken(token, true);
    assert.equal(local.values.githubSyncToken, token);
    assert.equal(session.values.githubSyncToken, undefined);
  });

  it("removeToken clears both areas and getToken rejects a stored empty token", async () => {
    const session = new MemorySessionStorage();
    const local = new MemoryLocalStorage();
    const tokens = new ChromeGitHubTokenStore(session, local);
    await tokens.setToken(token, true);
    await tokens.setToken("session-token", false);

    await tokens.removeToken();

    assert.isUndefined(await tokens.getToken(true));
    assert.isUndefined(await tokens.getToken(false));

    local.values.githubSyncToken = "";
    let error: unknown;
    try {
      await tokens.getToken(true);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
  });
});

describe("ConfiguredGitHubSyncRunner", () => {
  it("defaults its fetch to a globalThis-receiver arrow", async () => {
    const original = globalThis.fetch;
    let receiver: unknown = "unset";
    globalThis.fetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      receiver = this;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    try {
      const storage = new MemoryLocalStorage();
      storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
      const session = new MemorySessionStorage();
      const runner = new ConfiguredGitHubSyncRunner(
        new ChromeGitHubConnectionStore(storage),
        new ChromeGitHubTokenStore(session, storage),
        new ChromeGitHubSessionKeyStore(session),
        new AlwaysPermission(),
        new FakeJournal(),
        new FakeLocalAdapter(),
        deviceId,
      );
      const bound = (
        runner as unknown as {
          fetchImpl: (
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => Promise<Response>;
        }
      ).fetchImpl;
      await bound("https://api.github.com/fixture");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(receiver, globalThis);
  });

  it("reports unconfigured when no connection is stored and makes no remote calls", async () => {
    const storage = new MemoryLocalStorage();
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
      new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "unconfigured");
  });

  it("reports tokenRequired when no PAT is stored for the recorded area", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
    const tokens = new ChromeGitHubTokenStore(
      new MemorySessionStorage(),
      storage,
    );
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "tokenRequired");
  });

  it("reports permissionRequired without remote calls when the API origin permission is absent", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      new ChromeGitHubSessionKeyStore(session),
      new NeverPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "permissionRequired");
  });

  it("rejects a repository identity mismatch before reading or applying operations", async () => {
    const fixture = await encryptedFixture();
    const fixtureWithDifferentId = {
      ...fixture,
      config: {
        ...fixture.config,
        repositoryId: "99999999-9999-4999-8999-999999999999",
      } as typeof fixture.config,
    };
    // The blob sha no longer matches config.repositoryId, so rebuild bytes to
    // force a fingerprint mismatch as well as the id mismatch.
    const serialized = serializeRepositoryConfig(fixtureWithDifferentId.config);
    const bytesValue = new TextEncoder().encode(serialized);
    const sha = await gitBlobSha(bytesValue);
    const fingerprint = await repositoryConfigFingerprint(
      fixtureWithDifferentId.config,
    );
    const differentFixture = {
      config: fixtureWithDifferentId.config,
      bytes: bytesValue,
      sha,
      fingerprint,
    };

    const steps = inspectSteps(differentFixture);
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const journal = new FakeJournal();
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      new ChromeGitHubSessionKeyStore(session),
      new AlwaysPermission(),
      journal,
      new FakeLocalAdapter(),
      deviceId,
      scriptedFetch(steps),
    );

    let error: unknown;
    try {
      await runner.run(["manual"]);
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, GitHubRepositoryIdentityChangedError);
    assert.deepEqual(journal.events, []);
    assert.equal(steps.length, 0);
  });

  it("returns remoteMissing when the sync branch has no encrypted config", async () => {
    const fixture = await encryptedFixture();
    const steps = inspectSteps(fixture);
    // Replace the sync ref response with a missing branch.
    steps[2].response = new Response(null, { status: 404 });
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const journal = new FakeJournal();
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      new ChromeGitHubSessionKeyStore(session),
      new AlwaysPermission(),
      journal,
      new FakeLocalAdapter(),
      deviceId,
      scriptedFetch(steps),
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "remoteMissing");
    assert.deepEqual(journal.events, []);
  });

  it("returns needsSyncPassword when identity pins match but no data key is in session", async () => {
    const fixture = await encryptedFixture();
    const steps = [...inspectSteps(fixture), ...engineListSteps()];
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      new ChromeGitHubSessionKeyStore(session),
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
      scriptedFetch(steps),
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "needsSyncPassword");
    assert.equal(steps.length, 0);
  });

  it("fails closed on a durable operation missing from the remote branch", async () => {
    const fixture = await encryptedFixture();
    const steps = [...inspectSteps(fixture), ...engineListSteps()];
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const sessionKeys = new ChromeGitHubSessionKeyStore(session);
    await sessionKeys.setDataKey(bytes(7));
    const journal = new FakeJournal();
    journal.outbox.push({
      opId: "55555555-5555-4555-8555-555555555555",
      intentId: "intent-1",
      repositoryId,
      envelope: "fixed-encrypted-envelope",
      remoteAcknowledged: true,
    });
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      sessionKeys,
      new AlwaysPermission(),
      journal,
      new FakeLocalAdapter(),
      deviceId,
      scriptedFetch(steps),
    );

    let error: unknown;
    try {
      await runner.run(["manual"]);
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, RemoteHistoryRewrittenError);
    assert.deepEqual(journal.events, []);
    assert.equal(steps.length, 0);
  });
});

describe("createBackgroundSyncRuntime permission gate", () => {
  const request = {
    owner,
    repository: repositoryName,
    token,
    rememberToken: false,
  };

  async function withFetchSpy(operation: () => Promise<void>) {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      calls += 1;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    try {
      await operation();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  }

  it("gates connect on the api.github.com permission with zero fetch and zero persistence", async () => {
    const storage = new MemoryLocalStorage();
    const calls = await withFetchSpy(async () => {
      const runtime = await createBackgroundSyncRuntime(
        storage,
        { clear: async () => undefined },
        new NeverPermission(),
      );
      const result = await runtime.connect(request);
      assert.deepEqual(result, { status: "permissionRequired" });
    });
    assert.equal(calls, 0);
    assert.isUndefined(storage.values.githubSyncConnection);
  });

  it("gates inspect on the api.github.com permission with zero fetch and zero persistence", async () => {
    const storage = new MemoryLocalStorage();
    const calls = await withFetchSpy(async () => {
      const runtime = await createBackgroundSyncRuntime(
        storage,
        { clear: async () => undefined },
        new NeverPermission(),
      );
      const result = await runtime.inspect(request);
      assert.deepEqual(result, { status: "permissionRequired" });
    });
    assert.equal(calls, 0);
    assert.isUndefined(storage.values.githubSyncConnection);
  });
});

describe("githubInspectStored", () => {
  async function withoutFetch(operation: () => Promise<void>) {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      calls += 1;
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    try {
      await operation();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  }

  it("returns unconfigured with zero fetch when no connection is stored", async () => {
    const storage = new MemoryLocalStorage();
    const calls = await withoutFetch(async () => {
      const runtime = await createBackgroundSyncRuntime(
        storage,
        { clear: async () => undefined },
        new AlwaysPermission(),
        new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
        new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
      );
      assert.deepEqual(await runtime.inspectStored(), {
        status: "unconfigured",
      });
    });
    assert.equal(calls, 0);
  });

  it("returns permissionRequired with zero fetch without the API host permission", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
    const calls = await withoutFetch(async () => {
      const runtime = await createBackgroundSyncRuntime(
        storage,
        { clear: async () => undefined },
        new NeverPermission(),
        new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
        new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
      );
      const result = await runtime.inspectStored();
      assert.deepEqual(result, { status: "permissionRequired" });
    });
    assert.equal(calls, 0);
    // The gate never mutates the stored connection or persists new state.
    assert.deepEqual(
      storage.values.githubSyncConnection,
      connectionRecord("a".repeat(64)),
    );
    assert.equal(storage.values.githubSyncDetails, undefined);
  });

  it("returns tokenRequired when the stored PAT is absent", async () => {
    const fixture = await encryptedFixture();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
      new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
    );
    const result = await runtime.inspectStored();
    assert.deepEqual(result, { status: "tokenRequired" });
  });

  it("returns the verified existing config and never exposes the PAT", async () => {
    const fixture = await encryptedFixture();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const keyStore = new ChromeGitHubSessionKeyStore(session);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    const steps = inspectSteps(fixture);
    await withGlobalScriptedFetch(steps, async () => {
      const result = await runtime.inspectStored();
      if (result.status !== "existing") {
        assert.fail("expected existing");
      } else {
        assert.equal(result.owner, owner);
        assert.equal(result.repository, repositoryName);
        assert.equal(result.branch, branch);
        assert.deepEqual(result.config, fixture.config);
        assert.equal(JSON.stringify(result).includes(token), false);
      }
    });
    // scriptedFetch rejects on any non-GET or unexpected call, so consuming
    // every step with zero writes is proven by an empty remaining list.
    assert.equal(steps.length, 0);
  });

  it("returns a safe repositoryChanged status for identity drift", async () => {
    const fixture = await encryptedFixture();
    const drifted = await (async () => {
      const config = {
        ...fixture.config,
        repositoryId: "99999999-9999-4999-8999-999999999999",
      } as typeof fixture.config;
      const serialized = serializeRepositoryConfig(config);
      const bytesValue = new TextEncoder().encode(serialized);
      const sha = await gitBlobSha(bytesValue);
      const fingerprint = await repositoryConfigFingerprint(config);
      return { config, bytes: bytesValue, sha, fingerprint };
    })();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      new ChromeGitHubSessionKeyStore(session),
    );
    const steps = inspectSteps(drifted);
    await withGlobalScriptedFetch(steps, async () => {
      assert.deepEqual(await runtime.inspectStored(), {
        status: "repositoryChanged",
      });
    });
    assert.equal(steps.length, 0);
  });
});

describe("githubUnlock", () => {
  const goodKek = bytes(4);
  const badKek = bytes(9);

  it("returns needsSyncPassword, performs zero remote writes, and mutates no key on a wrong KEK", async () => {
    const fixture = await encryptedFixture();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const keyStore = new ChromeGitHubSessionKeyStore(session);
    const existing = bytes(11);
    await keyStore.setDataKey(existing);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    const steps = inspectSteps(fixture);
    await withGlobalScriptedFetch(steps, async () => {
      const result = await runtime.unlock(badKek);
      assert.deepEqual(result, { status: "needsSyncPassword" });
    });
    assert.equal(steps.length, 0);
    assert.deepEqual(await keyStore.getDataKey(), existing);
  });

  it("stores only the session data key and unlocks on a correct KEK", async () => {
    const fixture = await encryptedFixture();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const keyStore = new ChromeGitHubSessionKeyStore(session);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    // Spy on the unlock's manual-sync trigger without running the background
    // cascade to completion (the browser test page has no live background).
    const triggered: Array<string> = [];
    runtime.triggers.immediate = (async (
      reason: "manual" | "popup" | "alarm",
    ) => {
      triggered.push(reason);
    }) as typeof runtime.triggers.immediate;

    const steps = inspectSteps(fixture);
    await withGlobalScriptedFetch(steps, async () => {
      const result = await runtime.unlock(goodKek);
      assert.deepEqual(result, { status: "unlocked" });
    });
    assert.equal(steps.length, 0);
    assert.deepEqual(triggered, ["manual"]);
    assert.deepEqual(await keyStore.getDataKey(), bytes(7));
    // The stored connection and token are untouched by unlock.
    assert.deepEqual(
      storage.values.githubSyncConnection,
      connectionRecord(fixture.fingerprint),
    );
    assert.equal(session.values.githubSyncToken, token);
  });

  it("returns unconfigured and permissionRequired without remote calls", async () => {
    const storage = new MemoryLocalStorage();
    const calls = await (async () => {
      const original = globalThis.fetch;
      let count = 0;
      globalThis.fetch = function (
        this: unknown,
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ) {
        count += 1;
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      };
      try {
        const unconfiguredRuntime = await createBackgroundSyncRuntime(
          storage,
          { clear: async () => undefined },
          new AlwaysPermission(),
          new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
          new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
        );
        assert.deepEqual(await unconfiguredRuntime.unlock(goodKek), {
          status: "unconfigured",
        });
        storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
        const deniedRuntime = await createBackgroundSyncRuntime(
          storage,
          { clear: async () => undefined },
          new NeverPermission(),
          new ChromeGitHubTokenStore(new MemorySessionStorage(), storage),
          new ChromeGitHubSessionKeyStore(new MemorySessionStorage()),
        );
        assert.deepEqual(await deniedRuntime.unlock(goodKek), {
          status: "permissionRequired",
        });
      } finally {
        globalThis.fetch = original;
      }
      return count;
    })();
    assert.equal(calls, 0);
  });
});

describe("GitHubSyncDetails snapshot", () => {
  it("does not republish synced details after the connection is removed", async () => {
    const fixture = await encryptedFixture();
    const steps = [...inspectSteps(fixture), ...engineListSteps()];
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const connections = new ChromeGitHubConnectionStore(storage);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const sessionKeys = new ChromeGitHubSessionKeyStore(session);
    await sessionKeys.setDataKey(bytes(7));
    const baseFetch = scriptedFetch(steps);
    let releaseFetch!: () => void;
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let firstRequest = true;
    const guardedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (firstRequest) {
        firstRequest = false;
        signalFetchStarted();
        await fetchGate;
      }
      return baseFetch(input, init);
    };
    const written: GitHubSyncDetails[] = [];
    const runner = new ConfiguredGitHubSyncRunner(
      connections,
      tokens,
      sessionKeys,
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
      guardedFetch,
      async (details) => {
        written.push(details);
      },
    );

    const running = runner.run(["manual"]);
    await fetchStarted;
    await connections.remove();
    releaseFetch();

    assert.equal((await running).status, "unconfigured");
    assert.deepEqual(written, []);
  });

  it("keeps a live connection pending when only the generation changes", async () => {
    const fixture = await encryptedFixture();
    const steps = [...inspectSteps(fixture), ...engineListSteps()];
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const connections = new ChromeGitHubConnectionStore(
      storage,
      async () => undefined,
    );
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const sessionKeys = new ChromeGitHubSessionKeyStore(session);
    await sessionKeys.setDataKey(bytes(7));
    const baseFetch = scriptedFetch(steps);
    let releaseFetch!: () => void;
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let firstRequest = true;
    const guardedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (firstRequest) {
        firstRequest = false;
        signalFetchStarted();
        await fetchGate;
      }
      return baseFetch(input, init);
    };
    const runner = new ConfiguredGitHubSyncRunner(
      connections,
      tokens,
      sessionKeys,
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
      guardedFetch,
    );

    const running = runner.run(["manual"]);
    await fetchStarted;
    await connections.set(connectionRecord(fixture.fingerprint));
    releaseFetch();

    assert.equal((await running).status, "pending");
    assert.ok(await connections.get());
  });

  it("persists only allowed secret-free fields after a successful run", async () => {
    const fixture = await encryptedFixture();
    const steps = [...inspectSteps(fixture), ...engineListSteps()];
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokens = new ChromeGitHubTokenStore(session, storage);
    await tokens.setToken(token, false);
    const sessionKeys = new ChromeGitHubSessionKeyStore(session);
    await sessionKeys.setDataKey(bytes(7));
    const written: GitHubSyncDetails[] = [];
    const runner = new ConfiguredGitHubSyncRunner(
      new ChromeGitHubConnectionStore(storage),
      tokens,
      sessionKeys,
      new AlwaysPermission(),
      new FakeJournal(),
      new FakeLocalAdapter(),
      deviceId,
      scriptedFetch(steps),
      async (details) => {
        written.push(details);
      },
    );

    const result = await runner.run(["manual"]);

    assert.deepEqual(result.status, "synced");
    assert.equal(written.length, 1);
    const details = written[0];
    assert.equal(details.owner, owner);
    assert.equal(details.repository, repositoryName);
    assert.equal(details.branch, branch);
    assert.equal(details.headSha, headSha);
    assert.equal(details.headShortSha, headSha.slice(0, 7));
    assert.equal(details.pendingOperations, 0);
    assert.equal(details.rateLimitRemaining, 4999);
    assert.equal(details.rateLimitReset, 1700000000);
    const allowed = new Set([
      "owner",
      "repository",
      "branch",
      "headSha",
      "headShortSha",
      "pendingOperations",
      "rateLimitRemaining",
      "rateLimitReset",
      "lastPullAt",
      "lastPushAt",
    ]);
    for (const key of Object.keys(details)) {
      assert.ok(allowed.has(key), "unexpected details field: " + key);
    }
    const serialized = JSON.stringify(details);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("encrypted"), false);
  });
});

describe("stored-connection restart", () => {
  it("can inspect then survive a runtime restart and unlock from persisted state", async () => {
    const fixture = await encryptedFixture();
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(fixture.fingerprint);
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const keyStore = new ChromeGitHubSessionKeyStore(session);

    const firstRuntime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    const inspectStepsBuild = inspectSteps(fixture);
    await withGlobalScriptedFetch(inspectStepsBuild, async () => {
      const result = await firstRuntime.inspectStored();
      assert.equal(result.status, "existing");
    });
    assert.equal(inspectStepsBuild.length, 0);

    // Rebuild a fresh runtime over the same persisted storage (a restart).
    const secondRuntime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    const triggered: Array<string> = [];
    const originalImmediate = secondRuntime.triggers.immediate.bind(
      secondRuntime.triggers,
    );
    secondRuntime.triggers.immediate = ((
      reason: "manual" | "popup" | "alarm",
    ) => {
      triggered.push(reason);
      return originalImmediate(reason);
    }) as typeof secondRuntime.triggers.immediate;
    const unlockSteps = inspectSteps(fixture);
    await withGlobalScriptedFetch(unlockSteps, async () => {
      const result = await secondRuntime.unlock(bytes(4));
      assert.deepEqual(result, { status: "unlocked" });
    });
    assert.equal(unlockSteps.length, 0);
    assert.deepEqual(triggered, ["manual"]);
    assert.deepEqual(await keyStore.getDataKey(), bytes(7));
  });

  it("does not report unconfigured when a connection exists without a stored status", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      new ChromeGitHubSessionKeyStore(session),
    );

    const view = await runtime.getStatus();
    assert.equal(view.status, "needsSyncPassword");
    assert.isTrue(view.configured);
    assert.isFalse(view.unlocked);
    assert.isFalse(view.tokenRequired);
  });

  it("reports unlocked when the session still holds the data key", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord("a".repeat(64));
    storage.values.githubSyncStatus = {
      status: "synced",
      updatedAt: 20,
      lastSuccessfulSyncAt: 20,
    };
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, false);
    const keyStore = new ChromeGitHubSessionKeyStore(session);
    await keyStore.setDataKey(bytes(7));
    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );

    const view = await runtime.getStatus();
    assert.equal(view.status, "synced");
    assert.isTrue(view.configured);
    assert.isTrue(view.unlocked);
  });

  it("stays unlocked from local token and data key after session storage is wiped", async () => {
    const storage = new MemoryLocalStorage();
    storage.values.githubSyncConnection = connectionRecord(
      "a".repeat(64),
      true,
    );
    storage.values.githubSyncStatus = {
      status: "synced",
      updatedAt: 20,
      lastSuccessfulSyncAt: 20,
    };
    storage.values.githubSyncPassword = "device-password";
    const session = new MemorySessionStorage();
    const tokenStore = new ChromeGitHubTokenStore(session, storage);
    await tokenStore.setToken(token, true);
    const keyStore = new ChromeGitHubSessionKeyStore(session, storage);
    await keyStore.setDataKey(bytes(7), true);
    session.values = {};

    const runtime = await createBackgroundSyncRuntime(
      storage,
      { clear: async () => undefined },
      new AlwaysPermission(),
      tokenStore,
      keyStore,
    );
    const view = await runtime.getStatus();
    assert.equal(view.status, "synced");
    assert.isTrue(view.configured);
    assert.isTrue(view.unlocked);
    assert.isFalse(view.tokenRequired);

    await runtime.disconnect();
    assert.equal(storage.values.githubSyncPassword, undefined);
    assert.equal(storage.values.githubSyncToken, undefined);
    assert.equal(storage.values.githubRepositoryDataKey, undefined);
    assert.equal(storage.values.githubSyncConnection, undefined);
  });
});
