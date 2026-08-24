import "mocha";
import { assert } from "chai";

import {
  GitHubApiClient,
  GitHubHttpError,
} from "../../sync/github/GitHubApiClient";
import { gitBlobSha } from "../../sync/github/GitBlobSha";
import {
  GitHubBlobDecodeError,
  GitHubOperationStore,
  RemoteOperationRewrittenError,
} from "../../sync/github/GitHubOperationStore";
import {
  BranchProtectedError,
  CommitVerificationError,
  InvalidBatchError,
} from "../../sync/github/GitHubCommitWriter";

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

const deviceId = "11111111-1111-4111-8111-111111111111";
const opIdA = "22222222-2222-4222-8222-222222222222";
const opIdB = "33333333-3333-4333-8333-333333333333";

function flushOpIds(receipts: Array<{ opId: string }>) {
  return receipts.map((receipt) => receipt.opId);
}

interface RecordedRequest {
  method: string;
  url: string;
}

type ScriptStep = { method: string; url: string; response: Response | Error };

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
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

function treeResponse(sha: string, entries: object[], truncated = false) {
  return jsonResponse({
    sha,
    truncated,
    tree: entries,
  });
}

function assertStepsConsumed(steps: ScriptStep[]) {
  assert.equal(
    steps.length,
    0,
    `Unconsumed scripted steps: ${steps.map((step) => `${step.method} ${step.url}`).join(", ")}`,
  );
}

function opEntry(path: string, sha: string) {
  return { path, mode: "100644", type: "blob", sha, size: 10 };
}

function makeFetch(steps: ScriptStep[], requests: RecordedRequest[]) {
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
    if (step.response instanceof Error) {
      throw step.response;
    }
    return step.response;
  };
}

function writerSteps(
  sha: string,
  ops: string[],
  options: { existing?: object[] } = {},
) {
  const existing = options.existing ?? [];
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
      response: treeResponse(baseTreeSha, existing),
    },
    ...ops.map(() => ({
      method: "POST",
      url: BLOBS_URL,
      response: jsonResponse({ sha }, 201),
    })),
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
    { method: "GET", url: REF_GET_URL, response: refGetResponse(newCommitSha) },
    {
      method: "GET",
      url: `${COMMITS_URL}/${newCommitSha}`,
      response: commitGetResponse(newCommitSha, newTreeSha),
    },
    {
      method: "GET",
      url: `${TREES_URL}/${newTreeSha}?recursive=1`,
      response: treeResponse(
        newTreeSha,
        ops.map((opId) =>
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opId}.json`, sha),
        ),
      ),
    },
  ];
}

function makeStore(
  steps: ScriptStep[],
  requests: RecordedRequest[],
  options: Record<string, unknown> = {},
) {
  const client = new GitHubApiClient({ token }, makeFetch(steps, requests));
  const store = new GitHubOperationStore(client, owner, repository, branch, {
    maxFlushAttempts: 5,
    sleep: async () => undefined,
    ...options,
  });
  return { store, requests };
}

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

describe("GitHubOperationStore", () => {
  it("buffers uploads and confirms op ids only after an atomic commit", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const requests: RecordedRequest[] = [];
    const steps = [
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
        ]),
      },
    ];
    const { store, requests: recorded } = makeStore(steps, requests);

    assert.equal(await store.upload(deviceId, opIdA, bytesA), "created");
    assert.equal(await store.upload(deviceId, opIdB, bytesB), "created");

    const result = await store.flushUploads();

    assert.deepEqual(flushOpIds(result), [opIdA, opIdB]);
    const blobPosts = recorded.filter(
      (request) => request.method === "POST" && request.url === BLOBS_URL,
    );
    assert.equal(blobPosts.length, 2);
    const patch = recorded.find((request) => request.method === "PATCH");
    assert.equal(patch?.url, REF_URL);
    assertStepsConsumed(steps);
  });

  it("deduplicates buffered uploads and treats confirmed ops as exists", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps = writerSteps(sha, [opIdA]);
    const { store, requests: recorded } = makeStore(steps, requests);

    assert.equal(await store.upload(deviceId, opIdA, bytes), "created");
    assert.equal(await store.upload(deviceId, opIdA, bytes), "created");
    assert.deepEqual(flushOpIds(await store.flushUploads()), [opIdA]);
    assert.equal(
      recorded.filter((r) => r.method === "POST" && r.url === BLOBS_URL).length,
      1,
    );

    const before = recorded.length;
    assert.equal(await store.upload(deviceId, opIdA, bytes), "exists");
    assert.equal(recorded.length, before);
  });

  it("recovers a branch move by dropping already-landed operations and retrying", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const requests: RecordedRequest[] = [];
    const sleeps: number[] = [];
    const steps: ScriptStep[] = [
      // First writer attempt: race on PATCH.
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
      // Store reconciliation: only opA landed on the fresh head.
      {
        method: "GET",
        url: `${COMMITS_URL}/${freshHeadSha}`,
        response: commitGetResponse(freshHeadSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
        ]),
      },
      // Second writer attempt for opB only.
      {
        method: "GET",
        url: REF_GET_URL,
        response: refGetResponse(freshHeadSha),
      },
      {
        method: "GET",
        url: `${COMMITS_URL}/${freshHeadSha}`,
        response: commitGetResponse(freshHeadSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
        ]),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests, {
      backoffMilliseconds: () => 7,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });

    assert.equal(await store.upload(deviceId, opIdA, bytesA), "created");
    assert.equal(await store.upload(deviceId, opIdB, bytesB), "created");
    const result = await store.flushUploads();

    assert.deepEqual(flushOpIds(result), [opIdA, opIdB]);
    assert.deepEqual(sleeps, [7]);
    assertStepsConsumed(steps);
  });

  it("detects a rewritten remote operation during listing", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      ...writerSteps(sha, [opIdA]),
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
        response: treeResponse(newTreeSha, [
          opEntry(
            `AuthenticatorSync/ops/${deviceId}/${opIdA}.json`,
            "0".repeat(40),
          ),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytes);
    await store.flushUploads();

    await assertRejects(
      store.listOperationFiles(),
      RemoteOperationRewrittenError,
    );
    assertStepsConsumed(steps);
  });

  it("detects a previously confirmed operation that disappeared", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      ...writerSteps(sha, [opIdA]),
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
        response: treeResponse(newTreeSha, []),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytes);
    await store.flushUploads();

    await assertRejects(
      store.listOperationFiles(),
      RemoteOperationRewrittenError,
    );
    assertStepsConsumed(steps);
  });

  it("preserves buffered operations when a flush fails", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      // First flush: hard protection failure after commit creation.
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
        response: jsonResponse(
          {
            message:
              "Protected branch update failed for refs/heads/authenticator-sync.",
          },
          422,
        ),
      },
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      // Second flush succeeds for both operations.
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytesA);
    await store.upload(deviceId, opIdB, bytesB);

    await assertRejects(store.flushUploads(), BranchProtectedError);
    const retried = await store.flushUploads();
    assert.deepEqual(
      retried.map((receipt) => receipt.opId),
      [opIdA, opIdB],
    );
    assertStepsConsumed(steps);
  });

  it("gives up after repeated branch moves without dropping the buffer", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [];
    for (let round = 0; round < 2; round += 1) {
      steps.push(
        { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
        {
          method: "GET",
          url: `${COMMITS_URL}/${headSha}`,
          response: commitGetResponse(headSha, baseTreeSha),
        },
        {
          method: "GET",
          url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
          response: treeResponse(baseTreeSha, []),
        },
        {
          method: "POST",
          url: BLOBS_URL,
          response: jsonResponse({ sha }, 201),
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
        {
          method: "GET",
          url: `${COMMITS_URL}/${freshHeadSha}`,
          response: commitGetResponse(freshHeadSha, baseTreeSha),
        },
        {
          method: "GET",
          url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
          response: treeResponse(baseTreeSha, []),
        },
      );
    }
    const { store } = makeStore(steps, requests, { maxFlushAttempts: 2 });

    await store.upload(deviceId, opIdA, bytes);
    await assertRejects(store.flushUploads(), CommitVerificationError);

    const before = requests.length;
    assert.equal(await store.upload(deviceId, opIdA, bytes), "created");
    assert.equal(requests.length, before);
    assertStepsConsumed(steps);
  });

  it("lists operations only after flushing buffered uploads", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      ...writerSteps(sha, [opIdA]),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, sha),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytes);
    const files = await store.listOperationFiles();

    assert.equal(files.length, 1);
    assert.equal(files[0].opId, opIdA);
    assert.equal(files[0].sha, sha);
    const firstBlobPost = requests.findIndex(
      (request) => request.method === "POST" && request.url === BLOBS_URL,
    );
    const firstRecursiveListing = requests.findIndex(
      (request) =>
        request.method === "GET" &&
        request.url === `${TREES_URL}/${newTreeSha}?recursive=1`,
    );
    assert.ok(firstBlobPost >= 0);
    assert.ok(firstBlobPost < firstRecursiveListing);
  });

  it("downloads and strictly decodes a GitHub line-folded blob by sha", async () => {
    const envelope = JSON.stringify({
      formatVersion: 1,
      encrypted: true,
      ciphertext: "x".repeat(100),
    });
    const bytes = new TextEncoder().encode(envelope);
    const blobSha = await gitBlobSha(bytes);
    const base64 = btoa(envelope).replace(/(.{60})/g, "$1\n");
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${blobSha}`,
        response: jsonResponse({
          sha: blobSha,
          encoding: "base64",
          content: base64,
          size: bytes.byteLength,
        }),
      },
    ];
    const { store } = makeStore(steps, requests);

    const decoded = await store.download(deviceId, opIdA, blobSha);

    assert.equal(decoded, envelope);
    assert.equal(
      requests.some((request) => request.url.includes(token)),
      false,
    );
  });

  it("rejects malformed, oversized, and non-UTF-8 blobs", async () => {
    const requests: RecordedRequest[] = [];
    const malformedSteps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${"1".repeat(40)}`,
        response: jsonResponse({
          sha: "1".repeat(40),
          encoding: "base64",
          content: "not-base64!!",
        }),
      },
    ];
    const { store: malformedStore } = makeStore(malformedSteps, requests);
    await assertRejects(
      malformedStore.download(deviceId, opIdA, "1".repeat(40)),
      GitHubBlobDecodeError,
    );

    const oversizedBytes = new Uint8Array(1024 * 1024 + 1);
    const oversizedSteps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${"2".repeat(40)}`,
        response: jsonResponse({
          sha: "2".repeat(40),
          encoding: "base64",
          content: bytesToBase64(oversizedBytes),
        }),
      },
    ];
    const { store: oversizedStore } = makeStore(oversizedSteps, []);
    await assertRejects(
      oversizedStore.download(deviceId, opIdA, "2".repeat(40)),
      GitHubBlobDecodeError,
    );

    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const invalidUtf8Sha = await gitBlobSha(invalidUtf8);
    const invalidUtf8Base64 = btoa(String.fromCharCode(...invalidUtf8));
    const invalidSteps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${invalidUtf8Sha}`,
        response: jsonResponse({
          sha: invalidUtf8Sha,
          encoding: "base64",
          content: invalidUtf8Base64,
        }),
      },
    ];
    const { store: invalidStore } = makeStore(invalidSteps, []);
    await assertRejects(
      invalidStore.download(deviceId, opIdA, invalidUtf8Sha),
      GitHubBlobDecodeError,
    );
  });

  it("rejects a blob whose content does not match its sha", async () => {
    const requestedSha = "4".repeat(40);
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${requestedSha}`,
        response: jsonResponse({
          sha: requestedSha,
          encoding: "base64",
          content: btoa("envelope"),
          size: 8,
        }),
      },
    ];
    const { store } = makeStore(steps, []);

    await assertRejects(
      store.download(deviceId, opIdA, requestedSha),
      GitHubBlobDecodeError,
    );
  });

  it("rejects a blob response that omits its sha", async () => {
    const requestedSha = "5".repeat(40);
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: `https://api.github.com/repos/${owner}/${repository}/git/blobs/${requestedSha}`,
        response: jsonResponse({
          encoding: "base64",
          content: btoa("envelope"),
          size: 8,
        }),
      },
    ];
    const { store } = makeStore(steps, []);

    await assertRejects(
      store.download(deviceId, opIdA, requestedSha),
      GitHubBlobDecodeError,
    );
  });

  it("splits large pending buffers into deterministic batches", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const bytesC = new TextEncoder().encode("envelope-c");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const shaC = await gitBlobSha(bytesC);
    const opIdC = "44444444-4444-4444-8444-444444444444";
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      // Batch one: ops A and B.
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
        ]),
      },
      // Batch two: op C alone against the new head.
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
        ]),
      },
      {
        method: "POST",
        url: BLOBS_URL,
        response: jsonResponse({ sha: shaC }, 201),
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
        response: treeResponse(newTreeSha, [
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdA}.json`, shaA),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdB}.json`, shaB),
          opEntry(`AuthenticatorSync/ops/${deviceId}/${opIdC}.json`, shaC),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests, {
      maxOperationsPerBatch: 2,
    });

    assert.equal(await store.upload(deviceId, opIdA, bytesA), "created");
    assert.equal(await store.upload(deviceId, opIdB, bytesB), "created");
    assert.equal(await store.upload(deviceId, opIdC, bytesC), "created");
    const result = await store.flushUploads();
    assert.deepEqual(
      result.map((receipt) => receipt.opId),
      [opIdA, opIdB, opIdC],
    );
    const patches = requests.filter((request) => request.method === "PATCH");
    assert.equal(patches.length, 2);
    assertStepsConsumed(steps);
  });

  it("fails clearly when a single operation exceeds the batch byte limit", async () => {
    const bytes = new TextEncoder().encode("this-is-too-large");
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [];
    const { store } = makeStore(steps, requests, { maxBatchBytes: 4 });

    await store.upload(deviceId, opIdA, bytes);
    await assertRejects(store.flushUploads(), InvalidBatchError);

    const before = requests.length;
    assert.equal(await store.upload(deviceId, opIdA, bytes), "created");
    assert.equal(requests.length, before);
  });

  it("fails closed when a branch move reveals different remote content", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const shaB = await gitBlobSha(bytesB);
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      // Writer attempt races on PATCH.
      { method: "GET", url: REF_GET_URL, response: refGetResponse(headSha) },
      {
        method: "GET",
        url: `${COMMITS_URL}/${headSha}`,
        response: commitGetResponse(headSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        response: treeResponse(baseTreeSha, []),
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
      {
        method: "GET",
        url: `${COMMITS_URL}/${freshHeadSha}`,
        response: commitGetResponse(freshHeadSha, baseTreeSha),
      },
      {
        method: "GET",
        url: `${TREES_URL}/${baseTreeSha}?recursive=1`,
        // opA landed with DIFFERENT bytes than we buffered.
        response: treeResponse(baseTreeSha, [
          opEntry(
            `AuthenticatorSync/ops/${deviceId}/${opIdA}.json`,
            "0".repeat(40),
          ),
        ]),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytesA);
    await store.upload(deviceId, opIdB, bytesB);
    await assertRejects(store.flushUploads(), RemoteOperationRewrittenError);

    const before = requests.length;
    assert.equal(await store.upload(deviceId, opIdA, bytesA), "created");
    assert.equal(requests.length, before);
    assertStepsConsumed(steps);
  });

  it("fails closed when an upload reuses an id with different bytes", async () => {
    const bytesA = new TextEncoder().encode("envelope-a");
    const bytesB = new TextEncoder().encode("envelope-b");
    const shaA = await gitBlobSha(bytesA);
    const requests: RecordedRequest[] = [];
    const steps = writerSteps(shaA, [opIdA]);
    const { store } = makeStore(steps, requests);

    assert.equal(await store.upload(deviceId, opIdA, bytesA), "created");
    await assertRejects(store.upload(deviceId, opIdA, bytesB), Error);

    assert.deepEqual(flushOpIds(await store.flushUploads()), [opIdA]);
    await assertRejects(store.upload(deviceId, opIdA, bytesB), Error);
    assert.equal(await store.upload(deviceId, opIdA, bytesA), "exists");
    assertStepsConsumed(steps);
  });

  it("honors retry-after on rate-limited flushes", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const sleeps: number[] = [];
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REF_GET_URL,
        response: new Response(
          JSON.stringify({ message: "API rate limit exceeded" }),
          {
            status: 429,
            headers: {
              "retry-after": "3",
              "x-ratelimit-remaining": "0",
            },
          },
        ),
      },
      ...writerSteps(sha, [opIdA]),
    ];
    const { store } = makeStore(steps, requests, {
      backoffMilliseconds: () => 999,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });

    await store.upload(deviceId, opIdA, bytes);
    const result = await store.flushUploads();

    assert.deepEqual(flushOpIds(result), [opIdA]);
    assert.deepEqual(sleeps, [3000]);
    assertStepsConsumed(steps);
  });

  it("backs off exponentially on server errors without retry-after", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const sha = await gitBlobSha(bytes);
    const requests: RecordedRequest[] = [];
    const sleeps: number[] = [];
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REF_GET_URL,
        response: jsonResponse({ message: "Server Error" }, 500),
      },
      ...writerSteps(sha, [opIdA]),
    ];
    const { store } = makeStore(steps, requests, {
      backoffMilliseconds: () => 42,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });

    await store.upload(deviceId, opIdA, bytes);
    const result = await store.flushUploads();

    assert.deepEqual(flushOpIds(result), [opIdA]);
    assert.deepEqual(sleeps, [42]);
    assertStepsConsumed(steps);
  });

  it("propagates non-retryable permission failures and preserves the buffer", async () => {
    const bytes = new TextEncoder().encode("envelope");
    const requests: RecordedRequest[] = [];
    const steps: ScriptStep[] = [
      {
        method: "GET",
        url: REF_GET_URL,
        response: jsonResponse(
          { message: "Resource not accessible by personal access token" },
          403,
        ),
      },
    ];
    const { store } = makeStore(steps, requests);

    await store.upload(deviceId, opIdA, bytes);
    await assertRejects(store.flushUploads(), GitHubHttpError);

    const before = requests.length;
    assert.equal(await store.upload(deviceId, opIdA, bytes), "created");
    assert.equal(requests.length, before);
    assertStepsConsumed(steps);
  });

  it("rejects invalid upload inputs", async () => {
    const requests: RecordedRequest[] = [];
    const { store } = makeStore([], requests);
    const bytes = new TextEncoder().encode("envelope");

    await assertRejects(store.upload("bad-id", opIdA, bytes), Error);
    await assertRejects(store.upload(deviceId, "bad-id", bytes), Error);
    await assertRejects(store.upload(deviceId, opIdA, ""), Error);
    await assertRejects(
      store.upload(deviceId, opIdA, new Uint8Array(1024 * 1024 + 1)),
      Error,
    );
    await assertRejects(
      store.download(deviceId, opIdA, "bad-sha"),
      GitHubBlobDecodeError,
    );
    assert.deepEqual(requests, []);
  });
});
