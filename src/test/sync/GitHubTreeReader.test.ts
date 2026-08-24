import "mocha";
import { assert } from "chai";

import { GitHubApiClient } from "../../sync/github/GitHubApiClient";
import {
  GitHubOperationListingError,
  GitHubTreeReader,
} from "../../sync/github/GitHubTreeReader";

mocha.setup("bdd");

const token = "fake-token-not-a-real-pat";
const owner = "alice";
const repository = "auth-sync";
const branch = "authenticator-sync";

const REF_URL = `https://api.github.com/repos/${owner}/${repository}/git/ref/heads%2F${branch}`;
const COMMIT_URL = `https://api.github.com/repos/${owner}/${repository}/git/commits/`;
const TREE_URL = `https://api.github.com/repos/${owner}/${repository}/git/trees/`;

const headSha = "a".repeat(40);
const rootTreeSha = "c".repeat(40);
const syncTreeSha = "d".repeat(40);
const opsTreeSha = "e".repeat(40);
const deviceASha = "f".repeat(40);
const deviceBSha = "7".repeat(40);

const deviceA = "11111111-1111-4111-8111-111111111111";
const deviceB = "22222222-2222-4222-8222-222222222222";
const op1 = "33333333-3333-4333-8333-333333333333";
const op2 = "44444444-4444-4444-8444-444444444444";
const blob1Sha = "1".repeat(40);
const blob2Sha = "2".repeat(40);

interface RecordedRequest {
  method: string;
  url: string;
}

function refResponse(sha: string) {
  return JSON.stringify({
    ref: `refs/heads/${branch}`,
    url: `${REF_URL}`,
    object: { type: "commit", sha, url: `${REF_URL}` },
  });
}

function commitResponse(sha: string, treeSha: string) {
  return JSON.stringify({
    sha,
    tree: { sha: treeSha },
    parents: [{ sha: headSha }],
  });
}

function treeResponse(sha: string, truncated: boolean, entries: object[]) {
  return JSON.stringify({
    sha,
    truncated,
    tree: entries,
  });
}

function assertStepsConsumed(steps: unknown[]) {
  assert.equal(steps.length, 0, `Unconsumed scripted steps: ${steps.length}`);
}

function scriptedFetch(
  steps: Array<{ method: string; url: string; response: Response }>,
  requests: RecordedRequest[],
) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    requests.push({ method, url });
    const index = steps.findIndex(
      (step) => step.method === method && step.url === url,
    );
    if (index === -1) {
      throw new Error(`Unexpected ${method} ${url}`);
    }
    const [step] = steps.splice(index, 1);
    return step.response;
  };
}

function clientWith(
  steps: Array<{ method: string; url: string; response: Response }>,
) {
  const requests: RecordedRequest[] = [];
  const client = new GitHubApiClient({ token }, scriptedFetch(steps, requests));
  return { client, requests };
}

async function assertListingError(
  promise: Promise<unknown>,
  messagePart: string,
) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, GitHubOperationListingError);
  assert.match((error as Error).message, new RegExp(messagePart));
}

const opEntry = (path: string, sha: string) => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
  size: 10,
});

const treeEntry = (path: string, sha: string) => ({
  path,
  mode: "040000",
  type: "tree",
  sha,
});

describe("GitHubTreeReader", () => {
  it("enumerates operations from a complete recursive tree without reading blobs", async () => {
    const { client, requests } = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
            opEntry(`AuthenticatorSync/ops/${deviceA}/${op1}.json`, blob1Sha),
            opEntry(`AuthenticatorSync/ops/${deviceB}/${op2}.json`, blob2Sha),
            opEntry("README.md", "3".repeat(40)),
          ]),
        ),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const files = await reader.listOperationFiles(headSha);

    assert.deepEqual(
      files.map((file) => [file.deviceId, file.opId, file.sha]),
      [
        [deviceA, op1, blob1Sha],
        [deviceB, op2, blob2Sha],
      ],
    );
    assert.isFalse(
      requests.some((request) => request.url.includes("/git/blobs/")),
    );
  });

  it("falls back to a non-recursive walk when the recursive tree is truncated", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(treeResponse(rootTreeSha, true, [])),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          treeResponse(syncTreeSha, false, [
            treeEntry("ops", opsTreeSha),
            opEntry("config.json", "3".repeat(40)),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${opsTreeSha}`,
        response: new Response(
          treeResponse(opsTreeSha, false, [
            treeEntry(deviceA, deviceASha),
            treeEntry(deviceB, deviceBSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${deviceASha}`,
        response: new Response(
          treeResponse(deviceASha, false, [opEntry(`${op1}.json`, blob1Sha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${deviceBSha}`,
        response: new Response(
          treeResponse(deviceBSha, false, [opEntry(`${op2}.json`, blob2Sha)]),
        ),
      },
    ];
    const { client, requests } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const files = await reader.listOperationFiles(headSha);

    assert.deepEqual(
      files.map((file) => [file.deviceId, file.opId, file.sha]),
      [
        [deviceA, op1, blob1Sha],
        [deviceB, op2, blob2Sha],
      ],
    );
    assert.isFalse(
      requests.some((request) => request.url.includes("/git/blobs/")),
    );
    assertStepsConsumed(steps);
  });

  it("returns an empty listing when the sync directory does not exist", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            opEntry("README.md", "3".repeat(40)),
          ]),
        ),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    assert.deepEqual(await reader.listOperationFiles(headSha), []);
  });

  it("returns an empty listing after the first config commit", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          JSON.stringify({
            sha: "b".repeat(40),
            truncated: false,
            tree: [
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: blob1Sha,
                size: 13,
                url: `${TREE_URL}readme`,
              },
              {
                path: "AuthenticatorSync",
                mode: "040000",
                type: "tree",
                sha: syncTreeSha,
                url: `${TREE_URL}${syncTreeSha}`,
              },
              {
                path: "AuthenticatorSync/config.json",
                mode: "100644",
                type: "blob",
                sha: blob2Sha,
                size: 256,
                url: `${TREE_URL}config`,
              },
            ],
          }),
        ),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    assert.deepEqual(await reader.listOperationFiles(headSha), []);
  });

  it("fails closed when a device listing is truncated", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(treeResponse(rootTreeSha, true, [])),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          treeResponse(syncTreeSha, false, [treeEntry("ops", opsTreeSha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${opsTreeSha}`,
        response: new Response(
          treeResponse(opsTreeSha, false, [treeEntry(deviceA, deviceASha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${deviceASha}`,
        response: new Response(treeResponse(deviceASha, true, [])),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(reader.listOperationFiles(headSha), "truncated");
    assertStepsConsumed(steps);
  });

  it("rejects malformed operation paths and duplicate op ids", async () => {
    const badClient = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            opEntry(`AuthenticatorSync/ops/${deviceA}/notes.txt`, blob1Sha),
          ]),
        ),
      },
    ]);
    await assertListingError(
      new GitHubTreeReader(
        badClient.client,
        owner,
        repository,
        branch,
      ).listOperationFiles(headSha),
      "invalid operation file",
    );

    const duplicateClient = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            opEntry(`AuthenticatorSync/ops/${deviceA}/${op1}.json`, blob1Sha),
            opEntry(`AuthenticatorSync/ops/${deviceB}/${op1}.json`, blob2Sha),
          ]),
        ),
      },
    ]);
    await assertListingError(
      new GitHubTreeReader(
        duplicateClient.client,
        owner,
        repository,
        branch,
      ).listOperationFiles(headSha),
      "multiple devices",
    );
  });

  it("rejects a non-UUID device directory in the fallback walk", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(treeResponse(rootTreeSha, true, [])),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          treeResponse(syncTreeSha, false, [treeEntry("ops", opsTreeSha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${opsTreeSha}`,
        response: new Response(
          treeResponse(opsTreeSha, false, [
            treeEntry("not-a-uuid", deviceASha),
          ]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(reader.listOperationFiles(headSha), "UUIDv4");
    assertStepsConsumed(steps);
  });

  it("reports a missing branch as a typed listing error", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: REF_URL,
        response: new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        }),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(reader.getBranchHead(), "does not exist");
  });

  it("honors conditional branch reads with a cached head", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: REF_URL,
        response: new Response(null, {
          status: 304,
          headers: { etag: '"v2"' },
        }),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const head = await reader.getBranchHead({
      etag: '"v1"',
      cachedSha: headSha,
    });

    assert.equal(head.notModified, true);
    assert.equal(head.sha, headSha);
    assert.equal(head.etag, '"v2"');
  });

  it("rejects a 304 without a cached head", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: REF_URL,
        response: new Response(null, { status: 304 }),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(reader.getBranchHead({ etag: '"v1"' }), "cached");
  });

  it("lists operations even when GitHub returns a different tree sha", async () => {
    const { client } = clientWith([
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(syncTreeSha, false, [
            opEntry("README.md", "3".repeat(40)),
          ]),
        ),
      },
    ]);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    assert.deepEqual(await reader.listOperationFiles(headSha), []);
  });

  it("falls back to a non-recursive walk when the recursive response is too large", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(null, {
          status: 200,
          headers: { "Content-Length": String(9 * 1024 * 1024) },
        }),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          treeResponse(syncTreeSha, false, [treeEntry("ops", opsTreeSha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${opsTreeSha}`,
        response: new Response(
          treeResponse(opsTreeSha, false, [treeEntry(deviceA, deviceASha)]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${deviceASha}`,
        response: new Response(
          treeResponse(deviceASha, false, [opEntry(`${op1}.json`, blob1Sha)]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const files = await reader.listOperationFiles(headSha);

    assert.deepEqual(
      files.map((file) => [file.deviceId, file.opId, file.sha]),
      [[deviceA, op1, blob1Sha]],
    );
    assertStepsConsumed(steps);
  });

  it("rejects a non-directory ops resource in the fallback walk", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(treeResponse(rootTreeSha, true, [])),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          // ops exists but is a blob, not a directory.
          treeResponse(syncTreeSha, false, [opEntry("ops", opsTreeSha)]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(
      reader.listOperationFiles(headSha),
      "ops must be a directory",
    );
    assertStepsConsumed(steps);
  });

  it("ignores stray resources inside AuthenticatorSync in the fallback walk", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(treeResponse(rootTreeSha, true, [])),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
          ]),
        ),
      },
      {
        method: "GET",
        url: `${TREE_URL}${syncTreeSha}`,
        response: new Response(
          treeResponse(syncTreeSha, false, [
            opEntry("stray.json", "3".repeat(40)),
          ]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const files = await reader.listOperationFiles(headSha);
    assert.deepEqual(files, []);
    assertStepsConsumed(steps);
  });

  it("rejects nested directories under ops in the recursive listing", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
            treeEntry(`AuthenticatorSync/ops/${deviceA}/nested`, deviceASha),
          ]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    await assertListingError(
      reader.listOperationFiles(headSha),
      "invalid nested directory",
    );
    assertStepsConsumed(steps);
  });

  it("ignores stray files inside AuthenticatorSync in the recursive listing", async () => {
    const steps = [
      {
        method: "GET",
        url: `${COMMIT_URL}${headSha}`,
        response: new Response(commitResponse(headSha, rootTreeSha)),
      },
      {
        method: "GET",
        url: `${TREE_URL}${rootTreeSha}?recursive=1`,
        response: new Response(
          treeResponse(rootTreeSha, false, [
            treeEntry("AuthenticatorSync", syncTreeSha),
            opEntry("AuthenticatorSync/stray.json", blob1Sha),
          ]),
        ),
      },
    ];
    const { client } = clientWith(steps);
    const reader = new GitHubTreeReader(client, owner, repository, branch);

    const files = await reader.listOperationFiles(headSha);
    assert.deepEqual(files, []);
    assertStepsConsumed(steps);
  });
});
