import "mocha";
import { assert } from "chai";
import {
  githubSecretFields,
  resolveGitHubStatusView,
} from "../../sync/GitHubStatusView";

mocha.setup("bdd");

describe("resolveGitHubStatusView", () => {
  it("reports unconfigured only when no connection is stored", () => {
    assert.deepEqual(
      resolveGitHubStatusView({
        hasToken: false,
        hasDataKey: false,
      }),
      {
        status: "unconfigured",
        configured: false,
        unlocked: false,
        tokenRequired: false,
        updatedAt: 0,
        lastSuccessfulSyncAt: undefined,
      },
    );
  });

  it("does not treat a stored connection with no status as unconfigured", () => {
    const view = resolveGitHubStatusView({
      connection: { repositoryId: "repository" },
      hasToken: true,
      hasDataKey: true,
    });
    assert.equal(view.status, "pending");
    assert.isTrue(view.configured);
    assert.isTrue(view.unlocked);
    assert.isFalse(view.tokenRequired);
  });

  it("asks for the PAT when a connection exists but no token is stored", () => {
    const view = resolveGitHubStatusView({
      connection: { repositoryId: "repository" },
      storedStatus: {
        status: "synced",
        updatedAt: 20,
        lastSuccessfulSyncAt: 20,
      },
      hasToken: false,
      hasDataKey: false,
    });
    assert.deepInclude(view, {
      status: "tokenRequired",
      configured: true,
      unlocked: false,
      tokenRequired: true,
      lastSuccessfulSyncAt: 20,
    });
  });

  it("asks for the sync password when the session data key is missing", () => {
    const view = resolveGitHubStatusView({
      connection: { repositoryId: "repository" },
      storedStatus: {
        status: "unconfigured",
        updatedAt: 5,
      },
      hasToken: true,
      hasDataKey: false,
    });
    assert.deepInclude(view, {
      status: "needsSyncPassword",
      configured: true,
      unlocked: false,
      tokenRequired: false,
    });
  });

  it("keeps the last real unlocked status instead of a stale unconfigured write", () => {
    const view = resolveGitHubStatusView({
      connection: { repositoryId: "repository" },
      storedStatus: {
        status: "unconfigured",
        updatedAt: 5,
        lastSuccessfulSyncAt: 4,
      },
      hasToken: true,
      hasDataKey: true,
    });
    assert.deepInclude(view, {
      status: "pending",
      configured: true,
      unlocked: true,
      lastSuccessfulSyncAt: 4,
    });
  });
});

describe("githubSecretFields", () => {
  it("hides the password and unlock form once the session is unlocked", () => {
    assert.deepEqual(
      githubSecretFields({
        configured: true,
        unlocked: true,
        tokenRequired: false,
        hasRemoteConfig: true,
      }),
      {
        showPat: false,
        showPassword: false,
        showConfirmation: false,
        showConnectOrUnlock: false,
      },
    );
  });

  it("shows PAT and password when a reconnect needs the token again", () => {
    assert.deepEqual(
      githubSecretFields({
        configured: true,
        unlocked: false,
        tokenRequired: true,
        hasRemoteConfig: true,
      }),
      {
        showPat: true,
        showPassword: true,
        showConfirmation: false,
        showConnectOrUnlock: true,
      },
    );
  });
});
