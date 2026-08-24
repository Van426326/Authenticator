import "mocha";
import { assert } from "chai";

import { GitHubApiClient } from "../../sync/github/GitHubApiClient";
import {
  BranchMovedError,
  BranchProtectedError,
  CommitVerificationError,
  GitHubBranchMissingError,
  GitHubCommitWriter,
  ImmutablePathConflictError,
  InvalidBatchError,
} from "../../sync/github/GitHubCommitWriter";
import { gitBlobSha } from "../../sync/github/GitBlobSha";

mocha.setup("bdd");

const token = "fake-token-not-a-real-pat";
const owner = "alice";
const repository = "auth-sync";
const branch = "authenticator-sync";

const REF_URL = `https://api.github.com/repos/${owner}/${repository}/git/refs/heads%2F${branch}`;
const REF_GET_URL = `https://api.github.com/repos/${owner}/${repository}/git/ref/heads%2F${branch}`;
const BLOBS_URL = `https://api.github.com/repos/${owner}/${repository}/git/blobs`;
const TREES_URL = `https://api.github.com/repos/${owner}/${repository}/git/trees`;
const COMMITS_URL = `https://api.github.com/repos/${owner}/${repository}/git/commits`;

const headSha = "a".repeat(40);
const baseTreeSha = "b".repeat(40);
const newTreeSha = "c".repeat(40);
const newCommitSha = "d".repeat(40);
const freshHeadSha = "e".repeat(40);
const thirdPartySha = "5".repeat(40);
const thirdPartyTreeSha = "6".repeat(40);

const deviceId = "11111111-1111-4111-8111-111111111111";
const opIdA = "22222222-2222-4222-8222-222222222222";
const opIdB = "33333333-3333-4333-8333-333333333333";

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

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

function refGetResponse(sha: string) {
  return jsonResponse({
    ref: `refs/heads/${branch}`,
    object: { type: "commit", sha },
  });
}

function commitGetResponse(sha: string, treeSha: string) {
  return jsonResponse({
    sha,
    tree: { sha: treeSha },
    parents: [{ sha: headSha }],
  });
}

function treeResponse(sha: string, truncated: boolean, entries: object[]) {
  return jsonResponse({
    sha,
    truncated,
    tree: entries,
  });
}

function opEntry(path: string, sha: string) {
  return { path, mode: "100644", type: "blob", sha, size: 10 };
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
    `Unconsumed scripted steps: ${steps.map((step) => `${step.method} ${step.url}`).join(", ")}`,
  );
}

function opPath(opId: string) {
  return `AuthenticatorSync/ops/${deviceId}/${opId}.json`;
}

/**
 * Builds the full happy-path scripted steps for one appendOperations call that
 * writes one operation: ref, head commit, pre-write listing, blob, tree,
 * commit, ref patch, then presence verification on the current head.
 */
function appendSteps(
  blobSha: string,
  options: {
    existing?: object[];
    verificationHead?: string;
    verificationTreeSha?: string;
    verificationEntries?: object[];
  } = {},
) {
  const existing = options.existing ?? [];
  const verificationHead = options.verificationHead ?? newCommitSha;
  const verificationTreeSha = options.verificationTreeSha ?? newTreeSha;
  const verificationEntries = options.verificationEntries ?? [
    opEntry(opPath(opIdA), blobSha),
  ];
  return [
    { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
    {
      method: "GET",
      url: `${COMMITS_URL}/${headSha}`,
      response: commitGetResponse(headSha, baseTreeSha),
    },
    {
      method: "GET",
      url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
      response: treeResponse(baseTreeSha, false, existing),
    },
    {
      method: "POST",
      url: BLOBS_URL,
      response: jsonResponse({ sha: blobSha }, 201),
    },
    {
      method: "POST",
      url: TREES_URL,
      response: jsonResponse({ sha: newTreeSha }, 201),
    },
    {
      method: "POST",
      url: COMMITS_URL,
      response: jsonResponse({ sha: newCommitSha }, 201),
    },
    {
      method: "PATCH",
      url: REF_URL,
      response: jsonResponse({ sha: newCommitSha }),
    },
    {
      method: "GET",
      url: REF_GET_URL,
      response: refGetResponse(verificationHead),
    },
    {
      method: "GET",
      url: `${COMMITS_URL}/${verificationHead}`,
      response: commitGetResponse(verificationHead, verificationTreeSha),
    },
    {
      method: "GET",
      url: `${TREES_URL}/${verificationTreeSha}?recursive=1`,
      response: treeResponse(verificationTreeSha, false, verificationEntries),
    },
  ];
}

describe("GitHubCommitWriter", () => {
  it("commits an atomic batch with force:false and verifies the result", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      {
        method: "POST",
        url: BLOBS_URL,
        response: jsonResponse({ sha: shaA }, 201),
      },
      {
        method: "POST",
        url: BLOBS_URL,
        response: jsonResponse({ sha: shaB }, 201),
      },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(newCommitSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${newCommitSha}`,
        response: commitGetResponse(newCommitSha, newTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}?recursive=1`,
        response: treeResponse(newTreeSha, false, [
          opEntry(opPath(opIdA), shaA),
          opEntry(opPath(opIdB), shaB),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes: bytesA },
      { deviceId, opId: opIdB, bytes: bytesB },
    ]);

    assert.equal(committed, newCommitSha);
    const treeBody = requests.find(
      (r) => r.method === "POST" && r.url === TREES_URL,
    )?.body as {
      base_tree?: string;
      tree?: Array<{
        path?: string;
        mode?: string;
        type?: string;
        sha?: string;
      }>;
    };
    assert.equal(treeBody?.base_tree, baseTreeSha);
    assert.deepEqual(
      treeBody?.tree?.map((entry) => entry.path),
      [opPath(opIdA), opPath(opIdB)],
    );
    assert.ok(
      treeBody?.tree?.every(
        (entry) => entry.mode === "100644" && entry.type === "blob",
      ),
    );
    const commitBody = requests.find(
      (r) => r.method === "POST" && r.url === COMMITS_URL,
    )?.body as {
      message?: string;
      tree?: string;
      parents?: string[];
    };
    assert.equal(commitBody?.tree, newTreeSha);
    assert.deepEqual(commitBody?.parents, [headSha]);
    assert.match(
      commitBody?.message ?? "",
      /^Authenticator sync: 2 operation\(s\) from /,
    );
    const patchBody = requests.find((r) => r.method === "PATCH")?.body as {
      sha?: string;
      force?: boolean;
    };
    assert.equal(patchBody?.sha, newCommitSha);
    assert.equal(patchBody?.force, false);
    for (const request of requests) {
      assert.notInclude(request.url, token);
      assert.notInclude(JSON.stringify(request.body ?? ""), token);
    }
    assertStepsConsumed(steps);
  });

  it("repairs a legacy device path without force and preserves an archive copy", async () => {
    const targetDeviceId = "44444444-4444-4444-8444-444444444444";
    const sha = "7".repeat(40);
    const source = opPath(opIdA);
    const target = `AuthenticatorSync/ops/${targetDeviceId}/${opIdA}.json`;
    const archive = `AuthenticatorSyncLegacy/ops/${deviceId}/${opIdA}.json`;
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, [opEntry(source, sha)]),
      },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(newCommitSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${newCommitSha}`,
        response: commitGetResponse(newCommitSha, newTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}?recursive=1`,
        response: treeResponse(newTreeSha, false, [
          opEntry(target, sha),
          opEntry(archive, sha),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    assert.equal(
      await writer.repairLegacyOperationPaths([
        {
          opId: opIdA,
          fromDeviceId: deviceId,
          toDeviceId: targetDeviceId,
          sha,
        },
      ]),
      newCommitSha,
    );

    const treeBody = requests.find(
      (request) => request.method === "POST" && request.url === TREES_URL,
    )?.body as {
      tree?: Array<{
        path?: string;
        mode?: string;
        type?: string;
        sha?: string | null;
      }>;
    };
    assert.deepEqual(treeBody.tree, [
      { path: target, mode: "100644", type: "blob", sha },
      { path: archive, mode: "100644", type: "blob", sha },
      { path: source, sha: null },
    ]);
    const patch = requests.find((request) => request.method === "PATCH")
      ?.body as { force?: boolean };
    assert.equal(patch.force, false);
    assertStepsConsumed(steps);
  });

  it("treats a 409 ref race as a branch move and reports the fresh head", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse(
          { message: "Update is not a fast forward" },
          409,
        ),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(freshHeadSha),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, BranchMovedError);
    assert.equal((error as BranchMovedError).freshHeadSha, freshHeadSha);
    assertStepsConsumed(steps);
  });

  it("treats a 422 ref race with a changed head as a branch move", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse(
          { message: "Update is not a fast forward" },
          422,
        ),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(freshHeadSha),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, BranchMovedError);
    assert.equal((error as BranchMovedError).freshHeadSha, freshHeadSha);
    assertStepsConsumed(steps);
  });

  it("treats a transient non-fast-forward rejection as retryable even before the head changes", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse(
          { message: "Update is not a fast forward" },
          422,
        ),
      },
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, BranchMovedError);
    assert.equal((error as BranchMovedError).freshHeadSha, headSha);
    assertStepsConsumed(steps);
  });

  it("reports an explicit protected-branch rejection", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse(
          {
            message:
              "Protected branch update failed for refs/heads/authenticator-sync.",
          },
          422,
        ),
      },
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, BranchProtectedError);
    assertStepsConsumed(steps);
  });

  it("recovers a lost ref response by verification when the branch moved", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: new TypeError("Failed to fetch"),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(newCommitSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${newCommitSha}`,
        response: commitGetResponse(newCommitSha, newTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}?recursive=1`,
        response: treeResponse(newTreeSha, false, [
          opEntry(opPath(opIdA), sha),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes },
    ]);
    assert.equal(committed, newCommitSha);
    assertStepsConsumed(steps);
  });

  it("fails closed when a lost response did not move the branch", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: new TypeError("Failed to fetch"),
      },
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, CommitVerificationError);
    assertStepsConsumed(steps);
  });

  it("fails closed when verification cannot find a committed operation", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(newCommitSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${newCommitSha}`,
        response: commitGetResponse(newCommitSha, newTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}?recursive=1`,
        response: treeResponse(newTreeSha, false, []),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, CommitVerificationError);
    assertStepsConsumed(steps);
  });

  it("rejects oversized, empty, duplicate, and invalid batches before any remote write", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient({ token }, scriptedFetch([], requests));
    const writer = new GitHubCommitWriter(client, owner, repository, branch, {
      maxOperations: 2,
      maxBatchBytes: 8,
    });
    const bytes = new TextEncoder().encode("12345678");

    await assertRejects(writer.appendOperations([]), InvalidBatchError);
    await assertRejects(
      writer.appendOperations([
        { deviceId, opId: opIdA, bytes },
        { deviceId, opId: opIdB, bytes },
        { deviceId, opId: "44444444-4444-4444-8444-444444444444", bytes },
      ]),
      InvalidBatchError,
    );
    await assertRejects(
      writer.appendOperations([
        { deviceId, opId: opIdA, bytes },
        { deviceId, opId: opIdA, bytes },
      ]),
      InvalidBatchError,
    );
    await assertRejects(
      writer.appendOperations([{ deviceId: "not-a-uuid", opId: opIdA, bytes }]),
      InvalidBatchError,
    );
    assert.deepEqual(requests, []);
  });

  it("reports a missing branch as a typed error", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REF_GET_URL,
        response: jsonResponse({ message: "Not Found" }, 404),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    await assertRejects(
      writer.appendOperations([{ deviceId, opId: opIdA, bytes }]),
      GitHubBranchMissingError,
    );
    assertStepsConsumed(steps);
  });

  it("fails closed when the returned blob sha does not match the sent bytes", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      {
        method: "POST",
        url: BLOBS_URL,
        response: jsonResponse({ sha: "0".repeat(40) }, 201),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    await assertRejects(
      writer.appendOperations([{ deviceId, opId: opIdA, bytes }]),
      CommitVerificationError,
    );
    assertStepsConsumed(steps);
  });

  it("skips an operation that already exists with identical bytes without writing", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, [
          opEntry(opPath(opIdA), sha),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes },
    ]);

    assert.equal(committed, headSha);
    assert.isFalse(
      requests.some(
        (request) => request.method === "POST" || request.method === "PATCH",
      ),
    );
    assertStepsConsumed(steps);
  });

  it("rejects an operation path that exists with different bytes before any write", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, [
          opEntry(opPath(opIdA), "0".repeat(40)),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    let error: unknown;
    try {
      await writer.appendOperations([{ deviceId, opId: opIdA, bytes }]);
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, ImmutablePathConflictError);
    assert.isFalse(
      requests.some(
        (request) => request.method === "POST" || request.method === "PATCH",
      ),
    );
    assertStepsConsumed(steps);
  });

  it("succeeds when a third-party commit advanced the branch after our commit", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = appendSteps(sha, {
      verificationHead: thirdPartySha,
      verificationTreeSha: thirdPartyTreeSha,
      verificationEntries: [opEntry(opPath(opIdA), sha)],
    });
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes },
    ]);

    assert.equal(committed, thirdPartySha);
    assertStepsConsumed(steps);
  });

  it("recovers a lost response when a third-party descendant contains the operations", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: new TypeError("Failed to fetch"),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(thirdPartySha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${thirdPartySha}`,
        response: commitGetResponse(thirdPartySha, thirdPartyTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${thirdPartyTreeSha}?recursive=1`,
        response: treeResponse(thirdPartyTreeSha, false, [
          opEntry(opPath(opIdA), sha),
        ]),
      },
    ];
    const client = new GitHubApiClient(
      { token },
      scriptedFetch(steps, requests),
    );
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes },
    ]);

    assert.equal(committed, thirdPartySha);
    assertStepsConsumed(steps);
  });

  it("verifies through the non-recursive fallback when the recursive tree is truncated", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const steps: ScriptStep[] = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, false, []),
      },
      { method: "POST", url: BLOBS_URL, response: jsonResponse({ sha }, 201) },
      {
        method: "POST",
        url: TREES_URL,
        response: jsonResponse({ sha: newTreeSha }, 201),
      },
      {
        method: "POST",
        url: COMMITS_URL,
        response: jsonResponse({ sha: newCommitSha }, 201),
      },
      {
        method: "PATCH",
        url: REF_URL,
        response: jsonResponse({ sha: newCommitSha }),
      },
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(newCommitSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${newCommitSha}`,
        response: commitGetResponse(newCommitSha, newTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}?recursive=1`,
        response: treeResponse(newTreeSha, true, []),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${newTreeSha}`,
        response: treeResponse(newTreeSha, false, [
          {
            path: "AuthenticatorSync",
            mode: "040000",
            type: "tree",
            sha: freshHeadSha,
          },
        ]),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${freshHeadSha}`,
        response: treeResponse(freshHeadSha, false, [
          { path: "ops", mode: "040000", type: "tree", sha: thirdPartySha },
        ]),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${thirdPartySha}`,
        response: treeResponse(thirdPartySha, false, [
          {
            path: deviceId,
            mode: "040000",
            type: "tree",
            sha: thirdPartyTreeSha,
          },
        ]),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${thirdPartyTreeSha}`,
        response: treeResponse(thirdPartyTreeSha, false, [
          opEntry(`${opIdA}.json`, sha),
        ]),
      },
    ];
    const client = new GitHubApiClient({ token }, scriptedFetch(steps, []));
    const writer = new GitHubCommitWriter(client, owner, repository, branch);

    const committed = await writer.appendOperations([
      { deviceId, opId: opIdA, bytes },
    ]);

    assert.equal(committed, newCommitSha);
    assertStepsConsumed(steps);
  });
});

async function assertRejects<T extends Error>(
  promise: Promise<unknown>,
  errorType: new (...args: never[]) => T,
) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, errorType);
  return error as T;
}
