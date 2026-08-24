import "mocha";
import { assert } from "chai";

import { GitHubApiClient } from "../../sync/github/GitHubApiClient";
import { gitBlobSha } from "../../sync/github/GitBlobSha";
import {
  GitHubConfigDataError,
  GitHubConfigMalformedError,
  GitHubConfigNotInitializedError,
  GitHubConfigRaceError,
} from "../../sync/github/GitHubRepository";
import {
  GitHubEmptyRepositoryError,
  GitHubPlaintextConfigError,
  GitHubPublicRepositoryError,
  GitHubRepository,
  GitHubRepositoryIdentityChangedError,
  GitHubRepositoryPermissionError,
} from "../../sync/github/GitHubRepository";
import {
  createEncryptedRepositoryConfig,
  createUnencryptedRepositoryConfig,
  EncryptedRepositoryConfig,
  RepositoryPasswordError,
  serializeRepositoryConfig,
} from "../../sync/RepositoryConfig";
import { encodeBase64 } from "../../sync/Base64";

mocha.setup("bdd");

const token = "fake-token-not-a-real-pat";
const owner = "alice";
const repositoryName = "auth-sync";
const branch = "authenticator-sync";

const CLIENT_PREFIX = `https://api.github.com/repos/${owner}/${repositoryName}`;
const REPO_URL = `${CLIENT_PREFIX}`;
const DEFAULT_REF_URL = `${CLIENT_PREFIX}/git/ref/heads%2Fmain`;
const SYNC_REF_URL = `${CLIENT_PREFIX}/git/ref/heads%2F${branch}`;
const SYNC_REF_PATCH_URL = `${CLIENT_PREFIX}/git/refs/heads%2F${branch}`;
const REFS_POST_URL = `${CLIENT_PREFIX}/git/refs`;
const BLOBS_POST_URL = `${CLIENT_PREFIX}/git/blobs`;
const TREES_POST_URL = `${CLIENT_PREFIX}/git/trees`;
const COMMITS_POST_URL = `${CLIENT_PREFIX}/git/commits`;
const commitUrl = (sha: string) => `${CLIENT_PREFIX}/git/commits/${sha}`;
const treeUrl = (sha: string) => `${CLIENT_PREFIX}/git/trees/${sha}`;
const blobUrl = (sha: string) => `${CLIENT_PREFIX}/git/blobs/${sha}`;

const headSha = "1".repeat(40);
const defaultHead = "2".repeat(40);
const headTreeSha = "3".repeat(40);
const asTreeSha = "4".repeat(40);
const freshHead = "5".repeat(40);
const freshTreeSha = "6".repeat(40);
const newTreeSha = "7".repeat(40);
const newCommitSha = "8".repeat(40);
const licenseSha = "9".repeat(40);
const otherHead = "a".repeat(40);
const otherTreeSha = "b".repeat(40);

const repositoryId = "11111111-1111-4111-8111-111111111111";
const winnerRepositoryId = "22222222-2222-4222-8222-222222222222";

const kdf = {
  name: "argon2id" as const,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  time: 2,
  memoryKiB: 19456,
  parallelism: 1,
  hashLength: 32,
};

const winnerKdf = {
  name: "argon2id" as const,
  salt: "AQIDBAUGBwgJCgsMDQ4PEA==",
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

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function repoResponse(
  options: {
    private?: boolean;
    defaultBranch?: string | null;
    permissions?: { pull?: boolean; push?: boolean };
  } = {},
) {
  return jsonResponse({
    private: options.private ?? true,
    default_branch: options.defaultBranch ?? "main",
    size: 42,
    permissions: options.permissions ?? { pull: true, push: true },
  });
}

function refResponse(sha: string) {
  return jsonResponse({
    ref: `refs/heads/${branch}`,
    object: { type: "commit", sha },
  });
}

function commitResponse(sha: string, treeSha: string, parent = headSha) {
  return jsonResponse({
    sha,
    tree: { sha: treeSha },
    parents: [{ sha: parent }],
  });
}

function treeResponse(sha: string, entries: object[]) {
  return jsonResponse({ sha, truncated: false, tree: entries });
}

function scriptedFetch(steps: ScriptStep[], requests: RecordedRequest[]) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const parsedBody =
      typeof init.body === "string" && init.body.length > 0
        ? JSON.parse(init.body)
        : undefined;
    requests.push({ method, url, body: parsedBody });
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

function assertStepsConsumed(steps: ScriptStep[]) {
  assert.equal(
    steps.length,
    0,
    `Unconsumed scripted steps: ${steps
      .map((step) => `${step.method} ${step.url}`)
      .join(", ")}`,
  );
}

function buildRepository(steps: ScriptStep[]) {
  const requests: RecordedRequest[] = [];
  const client = new GitHubApiClient({ token }, scriptedFetch(steps, requests));
  const repository = new GitHubRepository(
    client,
    owner,
    repositoryName,
    branch,
  );
  return { repository, requests, steps };
}

async function encryptedConfig(id: string) {
  const result = await createEncryptedRepositoryConfig(kdf, kek, {
    repositoryId: id,
    createdAt: 123,
    dataKey: bytes(7),
    nonce: new Uint8Array(12).fill(9),
  });
  const serialized = serializeRepositoryConfig(result.config);
  const configBytes = new TextEncoder().encode(serialized);
  const sha = await gitBlobSha(configBytes);
  return { config: result.config, bytes: configBytes, sha, serialized };
}

describe("GitHubRepository", () => {
  it("inspects an existing private repository with a valid encrypted config", async () => {
    const { config, sha, serialized } = await encryptedConfig(repositoryId);
    const foldedContent = encodeBase64(
      new TextEncoder().encode(serialized),
    ).replace(/(.{60})/g, "$1\n");
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
          { path: "LICENSE", mode: "100644", type: "blob", sha: licenseSha },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: foldedContent,
          size: serialized.length,
        }),
      },
    ];
    const { repository, steps: remaining } = buildRepository(steps);

    const inspection = await repository.inspect();

    assert.equal(inspection.branchExists, true);
    assert.equal(inspection.branchHeadSha, headSha);
    assert.deepEqual(inspection.config, config);
    assert.equal(inspection.repository.privateRepo, true);
    assertStepsConsumed(remaining);
  });

  it("inspects with zero remote writes", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    const inspection = await repository.inspect();

    assert.equal(inspection.config, undefined);
    assert.equal(inspection.branchExists, true);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("rejects a public repository", async () => {
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REPO_URL,
        response: repoResponse({ private: false }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubPublicRepositoryError);
  });

  it("rejects an empty repository before any write", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: new Response(null, { status: 404 }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({
        candidate: await encryptedConfig(repositoryId).then((r) => r.config),
        kek,
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubEmptyRepositoryError);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("rejects insufficient Contents write permission", async () => {
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REPO_URL,
        response: repoResponse({ permissions: { pull: true, push: false } }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubRepositoryPermissionError);
  });

  it("reports unconfigured when the sync branch is missing", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
    ];
    const { repository } = buildRepository(steps);

    const inspection = await repository.inspect();

    assert.equal(inspection.branchExists, false);
    assert.equal(inspection.config, undefined);
  });

  it("fails closed when AuthenticatorSync is a blob", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "100644",
            type: "blob",
            sha: licenseSha,
          },
        ]),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubConfigMalformedError);
  });

  it("fails closed when config.json is a directory", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          {
            path: "config.json",
            mode: "040000",
            type: "tree",
            sha: licenseSha,
          },
        ]),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubConfigMalformedError);
  });

  it("rejects a plaintext config", async () => {
    const config = createUnencryptedRepositoryConfig({
      repositoryId,
      createdAt: 123,
    });
    const serialized = serializeRepositoryConfig(config);
    const sha = await gitBlobSha(new TextEncoder().encode(serialized));
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubPlaintextConfigError);
  });

  it("rejects malformed config content", async () => {
    const serialized = "not json";
    const sha = await gitBlobSha(new TextEncoder().encode(serialized));
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubConfigDataError);
  });

  it("initializes a first encrypted config with force always false", async () => {
    const { config, bytes, sha } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: treeResponse(newTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(bytes),
          size: bytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
    ];
    const { repository, requests } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, true);
    assert.equal(result.branchHeadSha, newCommitSha);
    assert.deepEqual(result.config, config);
    assert.equal(result.access.repositoryId, repositoryId);
    assert.equal(result.access.mode, "aes-256-gcm");
    assert.ok(result.access.dataKey && result.access.dataKey.byteLength === 32);

    const patch = requests.find((request) => request.method === "PATCH");
    if (!patch) {
      throw new Error("Expected a PATCH request");
    }
    assert.deepEqual(patch.body, { sha: newCommitSha, force: false });
    for (const request of requests) {
      assert.notInclude(request.url, token);
      if (request.body !== undefined) {
        assert.notInclude(JSON.stringify(request.body), token);
      }
    }
  });

  it("verifies a newly written config listed as AuthenticatorSync/config.json", async () => {
    const { config, bytes, sha } = await encryptedConfig(repositoryId);
    const folded = encodeBase64(bytes).replace(/(.{60})/g, "$1\n");
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: jsonResponse({
          sha: otherTreeSha,
          truncated: false,
          tree: [
            {
              path: "README.md",
              mode: "100644",
              type: "blob",
              sha: licenseSha,
              size: 13,
            },
            {
              path: "AuthenticatorSync/config.json",
              mode: "100644",
              type: "blob",
              sha,
              size: bytes.byteLength,
            },
          ],
        }),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: folded,
          size: bytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
    ];
    const { repository } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, true);
    assert.deepEqual(result.config, config);
  });

  it("adopts an existing config with the correct password without writing", async () => {
    const { config, sha, serialized } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    const result = await repository.initialize({ kek });

    assert.equal(result.created, false);
    assert.deepEqual(result.config, config);
    assert.equal(result.branchHeadSha, headSha);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("rejects a wrong sync password before any write", async () => {
    const { sha, serialized } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({ kek: wrongKek });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, RepositoryPasswordError);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("adopts the winner config on a two-device initialization race", async () => {
    const { config, sha } = await encryptedConfig(repositoryId);
    const winner = await encryptedConfig(winnerRepositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: new Response(null, { status: 409 }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(freshHead) },
      {
        method: "GET",
        url: commitUrl(freshHead),
        response: commitResponse(freshHead, freshTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(freshTreeSha),
        response: treeResponse(freshTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          {
            path: "config.json",
            mode: "100644",
            type: "blob",
            sha: winner.sha,
          },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(winner.sha),
        response: jsonResponse({
          sha: winner.sha,
          encoding: "base64",
          content: encodeBase64(winner.bytes),
          size: winner.bytes.byteLength,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, false);
    assert.equal(result.config.repositoryId, winnerRepositoryId);
    assert.equal(result.branchHeadSha, freshHead);
    const patches = requests.filter((request) => request.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { sha: newCommitSha, force: false });
  });

  it("throws a typed race error when the winner used a different sync password and KDF", async () => {
    const { config, sha } = await encryptedConfig(repositoryId);
    const winner = await createEncryptedRepositoryConfig(winnerKdf, bytes(11), {
      repositoryId: winnerRepositoryId,
      createdAt: 456,
      dataKey: bytes(7),
      nonce: new Uint8Array(12).fill(8),
    });
    const winnerSerialized = serializeRepositoryConfig(winner.config);
    const winnerBytes = new TextEncoder().encode(winnerSerialized);
    const winnerSha = await gitBlobSha(winnerBytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: new Response(null, { status: 409 }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(freshHead) },
      {
        method: "GET",
        url: commitUrl(freshHead),
        response: commitResponse(freshHead, freshTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(freshTreeSha),
        response: treeResponse(freshTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha: winnerSha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(winnerSha),
        response: jsonResponse({
          sha: winnerSha,
          encoding: "base64",
          content: encodeBase64(winnerBytes),
          size: winnerBytes.byteLength,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({
        candidate: config,
        kek,
        expectedMode: "aes-256-gcm",
      });
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, GitHubConfigRaceError);
    const race = caught as GitHubConfigRaceError;
    assert.deepEqual(race.config, winner.config);
    assert.notEqual(race.config.encryption.kdf.salt, kdf.salt);
    // After the winning config appeared, no further writes may be issued.
    const lastPatch = requests
      .map((request, index) => (request.method === "PATCH" ? index : -1))
      .reduce((a, b) => Math.max(a, b));
    for (const request of requests.slice(lastPatch + 1)) {
      assert.equal(request.method, "GET");
    }
  });

  it("retries against the fresh head when the branch moves after a successful ref update", async () => {
    const { config, bytes, sha } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(otherHead) },
      {
        method: "GET",
        url: commitUrl(otherHead),
        response: commitResponse(otherHead, otherTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(otherTreeSha),
        response: treeResponse(otherTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(otherHead),
        response: commitResponse(otherHead, otherTreeSha, defaultHead),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, otherHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: treeResponse(newTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(bytes),
          size: bytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
    ];
    const { repository } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, true);
    assert.equal(result.branchHeadSha, newCommitSha);
    assert.deepEqual(result.config, config);
  });

  it("fails closed with a race error when the branch moves during verification", async () => {
    const {
      config,
      bytes: candidateBytes,
      sha,
    } = await encryptedConfig(repositoryId);
    const winner = await createEncryptedRepositoryConfig(winnerKdf, bytes(11), {
      repositoryId: winnerRepositoryId,
      createdAt: 456,
      dataKey: bytes(7),
      nonce: new Uint8Array(12).fill(8),
    });
    const winnerSerialized = serializeRepositoryConfig(winner.config);
    const winnerBytes = new TextEncoder().encode(winnerSerialized);
    const winnerSha = await gitBlobSha(winnerBytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: treeResponse(newTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(candidateBytes),
          size: candidateBytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(otherHead) },
      {
        method: "GET",
        url: commitUrl(otherHead),
        response: commitResponse(otherHead, otherTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(otherTreeSha),
        response: treeResponse(otherTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha: winnerSha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(winnerSha),
        response: jsonResponse({
          sha: winnerSha,
          encoding: "base64",
          content: encodeBase64(winnerBytes),
          size: winnerBytes.byteLength,
        }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({
        candidate: config,
        kek,
        expectedMode: "aes-256-gcm",
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubConfigRaceError);
    assert.deepEqual((caught as GitHubConfigRaceError).config, winner.config);
  });

  it("inspects an empty tree even when GitHub returns a different tree sha", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: jsonResponse({
          sha: otherTreeSha,
          truncated: false,
          tree: [],
        }),
      },
    ];
    const { repository } = buildRepository(steps);

    const inspection = await repository.inspect();
    assert.equal(inspection.branchExists, true);
    assert.equal(inspection.config, undefined);
  });

  it("never overwrites an existing config even when a candidate differs", async () => {
    const { config, sha, serialized } = await encryptedConfig(repositoryId);
    const candidate = await encryptedConfig(winnerRepositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: candidate.config,
      kek,
    });

    assert.equal(result.created, false);
    assert.deepEqual(result.config, config);
    const writes = requests.filter((request) => request.method !== "GET");
    assert.deepEqual(writes, []);
  });

  it("fails closed when the expected fingerprint claims a different identity", async () => {
    const { sha, serialized } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(headSha) },
      {
        method: "GET",
        url: commitUrl(headSha),
        response: commitResponse(headSha, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(new TextEncoder().encode(serialized)),
          size: serialized.length,
        }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({
        kek,
        expectedFingerprint: "deadbeef",
        expectedRepositoryId: winnerRepositoryId,
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubRepositoryIdentityChangedError);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("rejects a plaintext candidate before any write", async () => {
    const plaintext = createUnencryptedRepositoryConfig({
      repositoryId,
      createdAt: 123,
    });
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
    ];
    const { repository, requests } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({
        candidate: plaintext as unknown as EncryptedRepositoryConfig,
        kek,
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubPlaintextConfigError);
    for (const request of requests) {
      assert.equal(request.method, "GET");
    }
  });

  it("requires an encrypted candidate when the repository has no config", async () => {
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
    ];
    const { repository } = buildRepository(steps);

    let caught: unknown;
    try {
      await repository.initialize({});
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, GitHubConfigNotInitializedError);
  });

  it("recovers a lost ref response when the commit landed", async () => {
    const { config, bytes, sha } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: new TypeError("fetch failed"),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: treeResponse(newTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(bytes),
          size: bytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
    ];
    const { repository } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, true);
    assert.equal(result.branchHeadSha, newCommitSha);
    assert.deepEqual(result.config, config);
  });

  it("retries against a fresh head when a lost response did not land", async () => {
    const { config, bytes, sha } = await encryptedConfig(repositoryId);
    const steps: ScriptStep[] = [
      { method: "GET", url: REPO_URL, response: repoResponse() },
      {
        method: "GET",
        url: DEFAULT_REF_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "GET",
        url: SYNC_REF_URL,
        response: new Response(null, { status: 404 }),
      },
      {
        method: "POST",
        url: REFS_POST_URL,
        response: refResponse(defaultHead),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      {
        method: "GET",
        url: treeUrl(headTreeSha),
        response: treeResponse(headTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(defaultHead),
        response: commitResponse(defaultHead, headTreeSha),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: new TypeError("fetch failed"),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(otherHead) },
      {
        method: "GET",
        url: commitUrl(otherHead),
        response: commitResponse(otherHead, otherTreeSha, defaultHead),
      },
      {
        method: "GET",
        url: treeUrl(otherTreeSha),
        response: treeResponse(otherTreeSha, []),
      },
      {
        method: "GET",
        url: commitUrl(otherHead),
        response: commitResponse(otherHead, otherTreeSha, defaultHead),
      },
      { method: "POST", url: BLOBS_POST_URL, response: jsonResponse({ sha }) },
      {
        method: "POST",
        url: TREES_POST_URL,
        response: jsonResponse({ sha: newTreeSha }),
      },
      {
        method: "POST",
        url: COMMITS_POST_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "PATCH",
        url: SYNC_REF_PATCH_URL,
        response: jsonResponse({
          object: { type: "commit", sha: newCommitSha },
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
      {
        method: "GET",
        url: commitUrl(newCommitSha),
        response: commitResponse(newCommitSha, newTreeSha, otherHead),
      },
      {
        method: "GET",
        url: treeUrl(newTreeSha),
        response: treeResponse(newTreeSha, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: asTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: treeUrl(asTreeSha),
        response: treeResponse(asTreeSha, [
          { path: "config.json", mode: "100644", type: "blob", sha },
        ]),
      },
      {
        method: "GET",
        url: blobUrl(sha),
        response: jsonResponse({
          sha,
          encoding: "base64",
          content: encodeBase64(bytes),
          size: bytes.byteLength,
        }),
      },
      { method: "GET", url: SYNC_REF_URL, response: refResponse(newCommitSha) },
    ];
    const { repository } = buildRepository(steps);

    const result = await repository.initialize({
      candidate: config,
      kek,
      expectedMode: "aes-256-gcm",
    });

    assert.equal(result.created, true);
    assert.equal(result.branchHeadSha, newCommitSha);
  });

  it("never places the token in a URL, request body, or error message", async () => {
    const echoToken = "SECRET_PAT_VALUE_12345";
    const client = new GitHubApiClient(
      { token: echoToken },
      async () =>
        new Response(
          JSON.stringify({ message: `Bad credentials for ${echoToken}` }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const repository = new GitHubRepository(
      client,
      owner,
      repositoryName,
      branch,
    );

    let caught: unknown;
    try {
      await repository.inspect();
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, Error);
    assert.notInclude((caught as Error).message, echoToken);
  });
});
