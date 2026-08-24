import "mocha";
import { assert } from "chai";

import {
  assertGitHubPath,
  classifyGitHubError,
  encodeBranchRef,
  encodePathSegment,
  GitHubApiClient,
  GitHubHttpError,
  GitHubMalformedResponseError,
  GitHubRedirectError,
  GitHubResponseTooLargeError,
  parseRateLimit,
  parseRetryAfter,
  repoPath,
  validateOwner,
  validateRepository,
} from "../../sync/github/GitHubApiClient";

mocha.setup("bdd");

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Response[], requests: RecordedRequest[]) {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch");
    }
    return response;
  };
}

function headersOf(request: RecordedRequest) {
  return new Headers(request.init.headers);
}

async function rejectWith<T extends Error>(
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

const token = "fake-token-not-a-real-pat";

describe("GitHubApiClient", () => {
  it("rejects invalid credentials, owners, repositories, and paths", () => {
    assert.throws(() => new GitHubApiClient({ token: "" }));
    assert.throws(() => new GitHubApiClient({ token: "has space" }));
    assert.throws(() => validateOwner("bad_owner!"));
    assert.throws(() => validateOwner(""));
    assert.throws(() => validateRepository("bad/repo"));
    assert.throws(() => validateRepository(".."));
    assert.throws(() => encodePathSegment("a/b"));
    assert.throws(() => encodePathSegment("a%20b"));
    assert.throws(() => encodeBranchRef("a\\b"));
    assert.throws(() => encodeBranchRef("a?b"));
    assert.throws(() => assertGitHubPath("no-leading-slash"));
    assert.throws(() => assertGitHubPath("/repos/x/y?query=1"));
    assert.throws(() => assertGitHubPath("/repos/.."));
    assert.throws(() => assertGitHubPath("/repos/%2e%2e/secret"));
    assert.throws(() => assertGitHubPath("/repos/./secret"));
    assert.throws(() => assertGitHubPath("/repos/%zz/secret"));
  });

  it("allows legal names containing consecutive dots", () => {
    assertGitHubPath("/repos/a..b/repo");
    assertGitHubPath("/repos/owner/repo..name");
  });

  it("builds encoded repository and branch reference paths", () => {
    assert.equal(repoPath("alice", "my-repo"), "/repos/alice/my-repo");
    assert.equal(
      repoPath("alice", "my-repo", "git/ref/heads/main"),
      "/repos/alice/my-repo/git/ref/heads/main",
    );
    assert.equal(encodeBranchRef("feature/login"), "feature%2Flogin");
    assert.equal(
      repoPath("alice", "my-repo", `git/ref/heads/${encodeBranchRef("feature/login")}`),
      "/repos/alice/my-repo/git/ref/heads/feature%2Flogin",
    );
    assert.throws(() => repoPath("alice", "my repo"));
  });

  it("sends bearer auth, API metadata, and never leaks the token", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient(
      { token },
      fakeFetch(
        [
          new Response(JSON.stringify({ id: 1 }), {
            status: 200,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-used": "1",
              "x-ratelimit-reset": "1750000000",
            },
          }),
        ],
        requests,
      ),
    );

    const result = await client.getJson<{ id: number }>(
      repoPath("alice", "my-repo"),
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.github.com/repos/alice/my-repo");
    assert.notInclude(requests[0].url, token);
    const headers = headersOf(requests[0]);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(headers.get("Accept"), "application/vnd.github+json");
    assert.equal(headers.get("X-GitHub-Api-Version"), "2022-11-28");
    assert.ok(headers.get("User-Agent"));
    assert.equal(result.notModified, false);
    assert.deepEqual(result.value, { id: 1 });
    assert.equal(result.rateLimit.limit, 5000);
    assert.equal(result.rateLimit.remaining, 4999);
    assert.equal(result.rateLimit.reset, 1750000000);
  });

  it("exposes a safe read-only copy of the last response metadata", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient(
      { token },
      fakeFetch(
        [
          new Response(JSON.stringify({ id: 1 }), {
            status: 200,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-used": "2",
              "x-ratelimit-reset": "1750000001",
            },
          }),
        ],
        requests,
      ),
    );

    assert.isUndefined(client.getLastResponseMeta());
    await client.getJson<{ id: number }>(repoPath("alice", "my-repo"));

    const meta = client.getLastResponseMeta();
    assert.ok(meta);
    assert.deepEqual(meta!.rateLimit, {
      limit: 5000,
      remaining: 4998,
      used: 2,
      reset: 1750000001,
    });
    // Mutating the returned copy must not affect later reads.
    meta!.rateLimit.remaining = 0;
    assert.equal(client.getLastResponseMeta()!.rateLimit.remaining, 4998);
  });

  it("performs conditional GET and reports 304 as not modified", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient(
      { token },
      fakeFetch([new Response(null, { status: 304 })], requests),
    );

    const result = await client.getJson<{ id: number }>(
      repoPath("alice", "my-repo"),
      { etag: '"abc123"' },
    );

    assert.equal(result.notModified, true);
    assert.isUndefined(result.value);
    assert.equal(headersOf(requests[0]).get("If-None-Match"), '"abc123"');
  });

  it("serializes JSON bodies for POST and PATCH", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient(
      { token },
      fakeFetch(
        [
          new Response(JSON.stringify({ sha: "newsha" }), { status: 201 }),
          new Response(JSON.stringify({ sha: "patched" }), { status: 200 }),
        ],
        requests,
      ),
    );

    await client.postJson(repoPath("alice", "my-repo", "git/trees"), {
      base_tree: "abc",
      tree: [],
    });
    await client.patchJson(repoPath("alice", "my-repo", "git/refs/heads/main"), {
      sha: "newsha",
      force: false,
    });

    assert.equal(
      headersOf(requests[0]).get("Content-Type"),
      "application/json",
    );
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      base_tree: "abc",
      tree: [],
    });
    assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
      sha: "newsha",
      force: false,
    });
  });

  it("serializes scalar query parameters into the request URL", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubApiClient(
      { token },
      fakeFetch([new Response("{\"id\":1}", { status: 200 })], requests)
    );

    await client.getJson<{ id: number }>(repoPath("alice", "my-repo"), {
      query: { recursive: 1, perPage: 50, bare: true },
    });

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://api.github.com/repos/alice/my-repo?recursive=1&perPage=50&bare=true"
    );
  });

  it("rejects invalid query values and byte limits fail-closed", async () => {
    const client = new GitHubApiClient(
      { token },
      fakeFetch([new Response("{\"id\":1}", { status: 200 })], [])
    );
    const path = repoPath("alice", "my-repo");

    await rejectWith(
      client.getJson(path, {
        query: { n: null as unknown as boolean },
      }),
      Error
    );
    await rejectWith(
      client.getJson(path, {
        query: { n: NaN },
      }),
      Error
    );
    await rejectWith(
      client.getJson(path, {
        query: { "": true },
      }),
      Error
    );
    await rejectWith(
      client.getJson(path, {
        maximumBytes: 0,
      }),
      Error
    );
    await rejectWith(
      client.getJson(path, {
        maximumBytes: NaN,
      }),
      Error
    );
    await rejectWith(
      client.getJson(path, {
        maximumBytes: -1,
      }),
      Error
    );
  });

  it("preserves HTTP error status, rate limit, and retry-after for oversized error bodies", async () => {
    const client = new GitHubApiClient(
      { token },
      async () =>
        new Response("oops".repeat(20 * 1024), {
          status: 429,
          headers: {
            "retry-after": "15",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-used": "5000",
            "x-ratelimit-reset": "1750000000",
          },
        })
    );

    const error = await rejectWith(
      client.getJson(repoPath("alice", "my-repo")),
      GitHubHttpError
    );
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 15);
    assert.equal(error.rateLimit.remaining, 0);
    assert.equal(error.rateLimit.limit, 5000);
    const classified = classifyGitHubError(error);
    assert.equal(classified.kind, "rateLimited");
    assert.isTrue(classified.retryable);
  });

  it("redacts the token from echoed server error fields", async () => {
    const client = new GitHubApiClient(
      { token },
      async () =>
        new Response(
          JSON.stringify({
            message: `echo ${token} in message`,
            documentation_url: `https://docs.example/${token}`,
          }),
          { status: 403 }
        )
    );

    const error = await rejectWith(
      client.getJson(repoPath("alice", "my-repo")),
      GitHubHttpError
    );
    assert.notInclude(error.message, token);
    assert.notInclude(error.githubMessage, token);
    assert.notInclude(error.documentationUrl, token);
  });

  it("redacts the token from non-JSON error fallback text", async () => {
    const client = new GitHubApiClient(
      { token },
      async () =>
        new Response(`plain text echoing bearer ${token} here`, { status: 502 })
    );

    const error = await rejectWith(
      client.getJson(repoPath("alice", "my-repo")),
      GitHubHttpError
    );
    assert.notInclude(error.message, token);
    assert.notInclude(error.githubMessage, token);
  });

  it("rejects opaque and status-zero responses", async () => {
    const opaque = new Response("{\"id\":1}", { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaque" });
    const clientOpaque = new GitHubApiClient({ token }, async () => opaque);
    await rejectWith(
      clientOpaque.getJson(repoPath("alice", "my-repo")),
      GitHubRedirectError
    );

    const statusZero = new Response("{\"id\":1}", { status: 200 });
    Object.defineProperty(statusZero, "status", { value: 0 });
    const clientZero = new GitHubApiClient({ token }, async () => statusZero);
    await rejectWith(
      clientZero.getJson(repoPath("alice", "my-repo")),
      GitHubRedirectError
    );
  });

  it("rejects redirects and cross-origin response URLs", async () => {
    const redirected = new Response(null, { status: 302 });
    const crossOrigin = new Response(JSON.stringify({ id: 1 }), {
      status: 200,
    });
    Object.defineProperty(crossOrigin, "url", {
      value: "https://evil.example/redirected",
    });

    const requests: RecordedRequest[] = [];
    const clientRedirect = new GitHubApiClient(
      { token },
      fakeFetch([redirected], requests),
    );
    await rejectWith(
      clientRedirect.getJson(repoPath("alice", "my-repo")),
      GitHubRedirectError,
    );

    const clientCross = new GitHubApiClient(
      { token },
      fakeFetch([crossOrigin], requests),
    );
    await rejectWith(
      clientCross.getJson(repoPath("alice", "my-repo")),
      GitHubRedirectError,
    );
  });

  it("limits response bytes and rejects malformed JSON", async () => {
    const oversized = new Response("x".repeat(1024 * 1024 + 1), {
      status: 200,
    });
    const clientLarge = new GitHubApiClient(
      { token },
      async () => oversized,
    );
    await rejectWith(
      clientLarge.getJson(repoPath("alice", "my-repo"), {
        maximumBytes: 1024 * 1024,
      }),
      GitHubResponseTooLargeError,
    );

    const malformed = new Response("not json {", { status: 200 });
    const clientBad = new GitHubApiClient(
      { token },
      async () => malformed,
    );
    await rejectWith(
      clientBad.getJson(repoPath("alice", "my-repo")),
      GitHubMalformedResponseError,
    );
  });

  it("preserves message and documentation URL on HTTP errors", async () => {
    const client = new GitHubApiClient(
      { token },
      async () =>
        new Response(
          JSON.stringify({
            message: "Bad credentials",
            documentation_url: "https://docs.github.com/rest",
          }),
          { status: 401, headers: { "x-ratelimit-remaining": "0" } },
        ),
    );

    const error = await rejectWith(
      client.getJson(repoPath("alice", "my-repo")),
      GitHubHttpError,
    );
    assert.equal(error.status, 401);
    assert.equal(error.githubMessage, "Bad credentials");
    assert.equal(
      error.documentationUrl,
      "https://docs.github.com/rest",
    );
    assert.notInclude(error.message, token);
    assert.equal(error.rateLimit.remaining, 0);
  });

  it("captures X-Accepted-GitHub-Permissions on success and errors", async () => {
    const successClient = new GitHubApiClient(
      { token },
      async () =>
        new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: {
            "x-accepted-github-permissions": "contents=read",
          },
        }),
    );
    const success = await successClient.getJson<{ id: number }>(
      repoPath("alice", "my-repo"),
    );
    assert.equal(success.acceptedPermissions, "contents=read");

    const errorClient = new GitHubApiClient(
      { token },
      async () =>
        new Response(
          JSON.stringify({ message: "Resource not accessible by personal access token" }),
          {
            status: 403,
            headers: {
              "x-accepted-github-permissions": "contents=write",
            },
          },
        ),
    );
    const error = await rejectWith(
      errorClient.getJson(repoPath("alice", "my-repo")),
      GitHubHttpError,
    );
    assert.equal(error.acceptedPermissions, "contents=write");
  });

  it("parses retry-after headers as seconds", () => {
    const headers = new Headers({ "retry-after": "30" });
    assert.equal(parseRetryAfter(headers), 30);
    assert.isUndefined(parseRetryAfter(new Headers()));
  });

  it("parses partial rate-limit metadata without asserting missing fields", () => {
    const limits = parseRateLimit(
      new Headers({ "x-ratelimit-remaining": "42" }),
    );
    assert.equal(limits.remaining, 42);
    assert.isUndefined(limits.limit);
  });

  it("classifies GitHub error statuses using rate-limit evidence", () => {
    const classify = (
      status: number,
      remaining?: number,
      retryAfter?: number
    ) =>
      classifyGitHubError(
        new GitHubHttpError({
          status,
          method: "GET",
          path: "/repos/alice/my-repo",
          rateLimit: remaining === undefined ? {} : { remaining },
          retryAfter,
        }),
      );

    assert.equal(classify(401).kind, "tokenInvalid");
    assert.equal(classify(403, 5).kind, "permissionDenied");
    assert.equal(classify(403, 5, 15).kind, "rateLimited");
    assert.equal(classify(403, 0).kind, "rateLimited");
    assert.equal(classify(429).kind, "rateLimited");
    assert.equal(classify(404).kind, "resourceNotFound");
    assert.equal(classify(409).kind, "conflict");
    assert.equal(classify(422).kind, "unprocessable");
    assert.equal(classify(503).kind, "serverError");
    assert.equal(classifyGitHubError(new TypeError("fetch failed")).kind, "network");
    assert.equal(classifyGitHubError(new GitHubRedirectError()).kind, "redirect");
    assert.equal(
      classifyGitHubError(new GitHubMalformedResponseError()).kind,
      "malformed",
    );
  });
});