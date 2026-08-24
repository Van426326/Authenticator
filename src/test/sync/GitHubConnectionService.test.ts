import "mocha";
import { assert } from "chai";

import { gitBlobSha } from "../../sync/github/GitBlobSha";
import {
  GitHubConnectionInitializer,
  GitHubConnectionRecord,
  GitHubConnectionRemote,
  GitHubConnectionRequest,
  GitHubConnectionService,
  GitHubConnectionStore,
} from "../../sync/github/GitHubConnectionService";
import {
  GitHubConfigRaceError,
  GitHubRepositoryIdentityChangedError,
} from "../../sync/github/GitHubRepository";
import {
  createEncryptedRepositoryConfig,
  RepositoryPasswordError,
  repositoryConfigFingerprint,
  serializeRepositoryConfig,
  verifyRepositoryAccess,
} from "../../sync/RepositoryConfig";
import { encodeBase64 } from "../../sync/Base64";

mocha.setup("bdd");

const token = "fake-token-not-a-real-pat";
const owner = "alice";
const repositoryName = "auth-sync";
const branch = "authenticator-sync";

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
const licenseSha = "9".repeat(40);
const repositoryId = "11111111-1111-4111-8111-111111111111";

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

const kek = bytes(4);
const wrongKek = bytes(9);

interface ScriptStep {
  method: string;
  url: string;
  response: Response | Error;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
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

class MemoryStore implements GitHubConnectionStore {
  record?: GitHubConnectionRecord;

  async get() {
    return this.record;
  }

  async set(record: GitHubConnectionRecord) {
    this.record = record;
  }

  async remove() {
    this.record = undefined;
  }
}

class RecordingRemote implements GitHubConnectionRemote {
  initializeRequests: GitHubConnectionRequest[] = [];

  async inspect(): Promise<never> {
    throw new Error("inspect should not be called during connect");
  }

  async initialize(request: GitHubConnectionRequest) {
    this.initializeRequests.push(request);
    const created = await createEncryptedRepositoryConfig(kdf, kek, {
      repositoryId: "33333333-3333-4333-8333-333333333333",
      createdAt: 123,
      dataKey: bytes(7),
      nonce: new Uint8Array(12).fill(9),
    });
    const access = await verifyRepositoryAccess(created.config, kek);
    return {
      branch,
      branchHeadSha: headSha,
      config: created.config,
      access,
      created: false,
    };
  }
}

async function encryptedFixture() {
  const encrypted = await createEncryptedRepositoryConfig(kdf, kek, {
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

function existingConfigSteps(
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
          { path: "LICENSE", mode: "100644", type: "blob", sha: licenseSha },
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

describe("GitHubConnectionService", () => {
  it("inspect is read-only and persists nothing", async () => {
    const steps: ScriptStep[] = [
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
        response: jsonResponse({
          object: { type: "commit", sha: defaultHead },
        }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
    ];
    const initializer = new GitHubConnectionInitializer(scriptedFetch(steps));
    const store = new MemoryStore();
    const service = new GitHubConnectionService(initializer, store);

    const result = await service.inspect({
      owner,
      repository: repositoryName,
      token,
    });

    assert.equal(result.status, "unconfigured");
    assert.equal(result.config, undefined);
    assert.equal(result.branch, branch);
    assert.equal(store.record, undefined);
    assert.equal(steps.length, 0);
  });

  it("connect persists only identity metadata and returns the data key", async () => {
    const fixture = await encryptedFixture();
    const steps = existingConfigSteps(fixture);
    const initializer = new GitHubConnectionInitializer(scriptedFetch(steps));
    const store = new MemoryStore();
    const service = new GitHubConnectionService(initializer, store);

    const result = await service.connect({
      owner,
      repository: repositoryName,
      token,
      kek,
    });

    assert.equal(result.status, "initializing");
    if (result.status !== "initializing") {
      return;
    }
    assert.equal(result.created, false);
    assert.equal(result.fingerprint, fixture.fingerprint);
    assert.deepEqual(result.config, fixture.config);
    assert.ok(result.dataKey && result.dataKey.byteLength === 32);

    const record = store.record;
    if (!record) {
      throw new Error("Expected a persisted connection record");
    }
    assert.equal(record.owner, owner);
    assert.equal(record.repository, repositoryName);
    assert.equal(record.branch, branch);
    assert.equal(record.repositoryId, repositoryId);
    assert.equal(record.mode, "aes-256-gcm");
    assert.equal(record.initialized, true);
    assert.equal(record.formatVersion, 1);
    assert.deepEqual(Object.keys(record).sort(), [
      "branch",
      "fingerprint",
      "formatVersion",
      "initialized",
      "mode",
      "owner",
      "rememberPassword",
      "rememberToken",
      "repository",
      "repositoryId",
    ]);
    assert.equal(record.rememberToken, false);
    assert.equal(record.rememberPassword, true);
    const loose = record as unknown as Record<string, unknown>;
    assert.equal(loose.token, undefined);
    assert.equal(loose.password, undefined);
    assert.equal(loose.syncPassword, undefined);
    assert.equal(loose.dataKey, undefined);
    assert.equal(steps.length, 0);
  });

  it("persists and returns the rememberToken choice without storing the token", async () => {
    const fixture = await encryptedFixture();
    const steps = existingConfigSteps(fixture);
    const initializer = new GitHubConnectionInitializer(scriptedFetch(steps));
    const store = new MemoryStore();
    const service = new GitHubConnectionService(initializer, store);

    const result = await service.connect({
      owner,
      repository: repositoryName,
      token,
      kek,
      rememberToken: true,
    });

    assert.equal(result.status, "initializing");
    const record = store.record;
    if (!record) {
      throw new Error("Expected a persisted connection record");
    }
    assert.equal(record.rememberToken, true);
    assert.equal(record.rememberPassword, true);
    const loose = record as unknown as Record<string, unknown>;
    assert.equal(loose.token, undefined);
    assert.equal(loose.syncPassword, undefined);
  });

  it("returns configRace with the published config and persists nothing", async () => {
    const fixture = await encryptedFixture();
    const store = new MemoryStore();
    const remote: GitHubConnectionRemote = {
      inspect: async () => {
        throw new Error("inspect should not be called during connect");
      },
      initialize: async () => {
        throw new GitHubConfigRaceError(fixture.config);
      },
    };
    const service = new GitHubConnectionService(remote, store);

    const result = await service.connect({
      owner,
      repository: repositoryName,
      token,
      kek: wrongKek,
    });

    assert.equal(result.status, "configRace");
    if (result.status !== "configRace") {
      return;
    }
    assert.deepEqual(result.config, fixture.config);
    assert.equal(store.record, undefined);
  });

  it("disconnect removes the stored record", async () => {
    const store = new MemoryStore();
    store.record = {
      formatVersion: 1,
      owner,
      repository: repositoryName,
      branch,
      repositoryId,
      fingerprint: "abc",
      mode: "aes-256-gcm",
      initialized: true,
      rememberToken: false,
    };
    const service = new GitHubConnectionService(
      null as unknown as {
        inspect: never;
        initialize: never;
      },
      store,
    );

    await service.disconnect();

    assert.equal(await store.get(), undefined);
  });

  it("rejects a stored identity mismatch before any remote call", async () => {
    const store = new MemoryStore();
    store.record = {
      formatVersion: 1,
      owner,
      repository: repositoryName,
      branch,
      repositoryId,
      fingerprint: "stored-fingerprint",
      mode: "aes-256-gcm",
      initialized: true,
      rememberToken: false,
    };
    const remote = new RecordingRemote();
    const service = new GitHubConnectionService(remote, store);

    const mismatches = [
      { owner: "bob", repository: repositoryName },
      { owner, repository: "other-repo" },
      { owner, repository: repositoryName, branch: "other-branch" },
    ];
    for (const partial of mismatches) {
      let caught: unknown;
      try {
        await service.connect({ ...partial, token });
      } catch (error) {
        caught = error;
      }
      assert.instanceOf(caught, GitHubRepositoryIdentityChangedError);
    }
    assert.equal(remote.initializeRequests.length, 0);
  });

  it("passes stored identity pins and never lets request pins weaken them", async () => {
    const store = new MemoryStore();
    store.record = {
      formatVersion: 1,
      owner,
      repository: repositoryName,
      branch,
      repositoryId: "33333333-3333-4333-8333-333333333333",
      fingerprint: "stored-fingerprint",
      mode: "aes-256-gcm",
      initialized: true,
      rememberToken: true,
    };
    const remote = new RecordingRemote();
    const service = new GitHubConnectionService(remote, store);

    await service.connect({
      owner,
      repository: repositoryName,
      token,
      kek,
      expectedRepositoryId: "weak-id",
      expectedFingerprint: "weak-fingerprint",
      expectedMode: "aes-256-gcm",
    });

    assert.equal(remote.initializeRequests.length, 1);
    const sent = remote.initializeRequests[0];
    assert.equal(
      sent.expectedRepositoryId,
      "33333333-3333-4333-8333-333333333333",
    );
    assert.equal(sent.expectedFingerprint, "stored-fingerprint");
    assert.equal(sent.expectedMode, "aes-256-gcm");
  });

  it("propagates a wrong sync password without persisting anything", async () => {
    const fixture = await encryptedFixture();
    const steps = existingConfigSteps(fixture);
    const initializer = new GitHubConnectionInitializer(scriptedFetch(steps));
    const store = new MemoryStore();
    const service = new GitHubConnectionService(initializer, store);

    let caught: unknown;
    try {
      await service.connect({
        owner,
        repository: repositoryName,
        token,
        kek: wrongKek,
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, RepositoryPasswordError);
    assert.equal(store.record, undefined);
    assert.equal(steps.length, 0);
  });
});
