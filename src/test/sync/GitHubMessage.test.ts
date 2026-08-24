import "mocha";
import { assert } from "chai";
import { encodeBase64 } from "../../sync/Base64";
import {
  assertGitHubMessageTrusted,
  GitHubMessageRuntime,
  parseGitHubConnectRequest,
} from "../../sync/GitHubMessage";

mocha.setup("bdd");

const runtimeId = "extension-id-123";
const extensionRoot = "chrome-extension://extension-id-123/";
const runtime: GitHubMessageRuntime = {
  id: runtimeId,
  getURL: (path) => `${extensionRoot}${path}`,
};

function connectRequest(overrides: Record<string, unknown> = {}) {
  return {
    owner: "alice",
    repository: "auth-sync",
    token: "fake-token-not-a-real-pat",
    ...overrides,
  };
}

describe("parseGitHubConnectRequest", () => {
  it("parses a valid connect request and pins the fixed sync branch", () => {
    const kek = encodeBase64(new Uint8Array(32).fill(7));
    const parsed = parseGitHubConnectRequest(
      connectRequest({ rememberToken: true, kek }),
    );

    assert.equal(parsed.owner, "alice");
    assert.equal(parsed.repository, "auth-sync");
    assert.equal(parsed.token, "fake-token-not-a-real-pat");
    assert.equal(parsed.rememberToken, true);
    assert.equal(parsed.rememberPassword, true);
    assert.equal(parsed.branch, "authenticator-sync");
    assert.deepEqual(
      Array.from(parsed.kek as Uint8Array),
      Array.from(new Uint8Array(32).fill(7)),
    );
    assert.isUndefined(parsed.candidate);
  });

  it("rejects a non-fixed sync branch", () => {
    assert.throws(() =>
      parseGitHubConnectRequest(connectRequest({ branch: "other-branch" })),
    );
  });

  it("rejects an unencrypted candidate config and a malformed KEK message", () => {
    assert.throws(() =>
      parseGitHubConnectRequest(
        connectRequest({
          candidate: { repositoryId: "11111111-1111-4111-8111-111111111111" },
        }),
      ),
    );
    assert.throws(() =>
      parseGitHubConnectRequest(connectRequest({ kek: "not-base64" })),
    );
  });

  it("rejects malformed requests without ever leaking the token into errors", () => {
    for (const value of [
      null,
      undefined,
      "string",
      [],
      {},
      { owner: "alice", repository: "repo" },
      { owner: "alice", repository: "repo", token: "" },
      { owner: "alice", repository: "", token: "t" },
      { owner: "", repository: "repo", token: "t" },
    ]) {
      let message = "";
      try {
        parseGitHubConnectRequest(value as Record<string, unknown>);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      assert.notEqual(message, "");
      assert.notInclude(message, "fake-token-not-a-real-pat");
    }
  });
});

describe("assertGitHubMessageTrusted", () => {
  it("ignores non-sync actions from any sender", () => {
    assert.doesNotThrow(() =>
      assertGitHubMessageTrusted(
        { action: "getTotp" },
        { id: "stranger", url: "https://evil.example" },
        runtime,
      ),
    );
  });

  it("accepts sync actions from the extension's own pages", () => {
    assert.doesNotThrow(() =>
      assertGitHubMessageTrusted(
        { action: "githubConnect" },
        { id: runtimeId, url: `${extensionRoot}view/popup.html` },
        runtime,
      ),
    );
    assert.doesNotThrow(() =>
      assertGitHubMessageTrusted(
        { action: "githubAccountMutation" },
        { id: runtimeId },
        runtime,
      ),
    );
  });

  it("rejects sync actions from an unknown sender id or foreign origin", () => {
    assert.throws(() =>
      assertGitHubMessageTrusted(
        { action: "githubConnect" },
        { id: "stranger", url: `${extensionRoot}view/popup.html` },
        runtime,
      ),
    );
    assert.throws(() =>
      assertGitHubMessageTrusted(
        { action: "githubGetStatus" },
        { id: runtimeId, url: "https://evil.example/popup.html" },
        runtime,
      ),
    );
  });
});
