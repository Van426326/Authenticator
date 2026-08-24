import "mocha";
import { assert } from "chai";

import { RepositoryPasswordError } from "../../sync/RepositoryConfig";
import { classifySyncError } from "../../sync/SyncError";
import { RemoteHistoryRewrittenError } from "../../sync/SyncEngineTypes";
import { RemoteOperationValidationError } from "../../sync/SyncEngine";
import {
  GitHubHttpError,
  GitHubMalformedResponseError,
} from "../../sync/github/GitHubApiClient";
import {
  BranchMovedError,
  BranchProtectedError,
  CommitVerificationError,
  GitHubBranchMissingError,
} from "../../sync/github/GitHubCommitWriter";
import {
  GitHubBlobDecodeError,
  RemoteOperationRewrittenError,
} from "../../sync/github/GitHubOperationStore";
import {
  GitHubConfigDataError,
  GitHubEmptyRepositoryError,
  GitHubPublicRepositoryError,
  GitHubRepositoryIdentityChangedError,
} from "../../sync/github/GitHubRepository";
import { GitHubOperationListingError } from "../../sync/github/GitHubTreeReader";

mocha.setup("bdd");

describe("classifySyncError", () => {
  it("maps integrity failures", () => {
    assert.equal(
      classifySyncError(new RemoteOperationValidationError("bad path")),
      "remoteCorrupt",
    );
  });

  it("prompts again when the repository password is incorrect", () => {
    assert.equal(
      classifySyncError(new RepositoryPasswordError()),
      "needsSyncPassword",
    );
  });

  it("maps network and unknown failures", () => {
    assert.equal(classifySyncError(new TypeError("fetch failed")), "offline");
    assert.equal(classifySyncError(new Error("unknown")), "error");
  });

  it("maps GitHub HTTP failures to actionable statuses", () => {
    const http = (status: number, options: Record<string, unknown> = {}) =>
      new GitHubHttpError({
        status,
        method: "GET",
        path: "/repos/a/b",
        rateLimit: {},
        ...options,
      });
    assert.equal(classifySyncError(http(401)), "authFailed");
    assert.equal(classifySyncError(http(403)), "permissionRequired");
    assert.equal(
      classifySyncError(http(403, { rateLimit: { remaining: 0 } })),
      "rateLimited"
    );
    assert.equal(
      classifySyncError(http(403, { retryAfter: 3 })),
      "rateLimited"
    );
    assert.equal(classifySyncError(http(404)), "remoteMissing");
    assert.equal(classifySyncError(http(429)), "rateLimited");
    assert.equal(classifySyncError(http(503)), "offline");
    assert.equal(classifySyncError(http(500)), "offline");
    assert.equal(classifySyncError(http(400)), "error");
  });

  it("maps GitHub history, protection, and identity failures", () => {
    assert.equal(
      classifySyncError(new RemoteHistoryRewrittenError("rewritten")),
      "historyRewritten"
    );
    assert.equal(
      classifySyncError(new RemoteOperationRewrittenError("rewritten")),
      "historyRewritten"
    );
    assert.equal(
      classifySyncError(new BranchProtectedError("protected")),
      "branchProtected"
    );
    assert.equal(
      classifySyncError(new BranchMovedError("1".repeat(40))),
      "error"
    );
    assert.equal(
      classifySyncError(new GitHubRepositoryIdentityChangedError()),
      "repositoryChanged"
    );
  });

  it("maps GitHub integrity and missing-resource failures", () => {
    assert.equal(
      classifySyncError(new GitHubOperationListingError("listing")),
      "remoteCorrupt"
    );
    assert.equal(
      classifySyncError(new GitHubBlobDecodeError("decode")),
      "remoteCorrupt"
    );
    assert.equal(
      classifySyncError(new GitHubConfigDataError("config")),
      "remoteCorrupt"
    );
    assert.equal(
      classifySyncError(new CommitVerificationError("verify")),
      "remoteCorrupt"
    );
    assert.equal(
      classifySyncError(new GitHubMalformedResponseError()),
      "remoteCorrupt"
    );
    assert.equal(
      classifySyncError(new GitHubBranchMissingError("branch")),
      "remoteMissing"
    );
    assert.equal(
      classifySyncError(new GitHubEmptyRepositoryError()),
      "remoteMissing"
    );
    assert.equal(
      classifySyncError(new GitHubPublicRepositoryError()),
      "unsupportedServer"
    );
  });
});
