import { RepositoryPasswordError } from "./RepositoryConfig";
import { SyncErrorClassifier } from "./SyncRunController";
import { RemoteHistoryRewrittenError } from "./SyncEngineTypes";
import {
  classifyGitHubError,
  GitHubHttpError,
  GitHubMalformedResponseError,
  GitHubRedirectError,
  GitHubResponseTooLargeError,
} from "./github/GitHubApiClient";
import {
  BranchMovedError,
  BranchProtectedError,
  CommitVerificationError,
  GitHubBranchMissingError,
  ImmutablePathConflictError,
  InvalidBatchError,
} from "./github/GitHubCommitWriter";
import {
  GitHubBlobDecodeError,
  RemoteOperationRewrittenError,
} from "./github/GitHubOperationStore";
import {
  GitHubConfigDataError,
  GitHubConfigMalformedError,
  GitHubConfigNotInitializedError,
  GitHubConfigRaceError,
  GitHubEmptyRepositoryError,
  GitHubPlaintextConfigError,
  GitHubPublicRepositoryError,
  GitHubRepositoryIdentityChangedError,
  GitHubRepositoryPermissionError,
} from "./github/GitHubRepository";
import { GitHubOperationListingError } from "./github/GitHubTreeReader";
import { RemoteOperationValidationError } from "./SyncEngine";

export const classifySyncError: SyncErrorClassifier = (error) => {
  if (error instanceof RepositoryPasswordError) {
    return "needsSyncPassword";
  }
  if (error instanceof RemoteHistoryRewrittenError) {
    return "historyRewritten";
  }
  if (error instanceof RemoteOperationRewrittenError) {
    return "historyRewritten";
  }
  if (error instanceof BranchProtectedError) {
    return "branchProtected";
  }
  if (error instanceof BranchMovedError) {
    // A branch move is a concurrent-writer race, not a protection rejection;
    // leave it to the generic error state so the run controller can retry on
    // the next trigger.
    return "error";
  }
  if (error instanceof GitHubRepositoryIdentityChangedError) {
    return "repositoryChanged";
  }
  if (error instanceof GitHubConfigRaceError) {
    // Should never reach the runtime classifier; the connection flow returns
    // a structured configRace result instead.
    return "error";
  }
  if (error instanceof GitHubHttpError) {
    const classification = classifyGitHubError(error);
    if (classification.rateLimited) {
      return "rateLimited";
    }
    if (classification.kind === "tokenInvalid") {
      return "authFailed";
    }
    if (classification.kind === "permissionDenied") {
      return "permissionRequired";
    }
    if (classification.kind === "resourceNotFound") {
      return "remoteMissing";
    }
    if (
      classification.kind === "serverError" ||
      classification.kind === "network"
    ) {
      return "offline";
    }
    if (classification.kind === "malformed") {
      return "remoteCorrupt";
    }
    if (classification.kind === "redirect") {
      return "unsupportedServer";
    }
    return "error";
  }
  if (
    error instanceof GitHubMalformedResponseError ||
    error instanceof GitHubResponseTooLargeError ||
    error instanceof GitHubBlobDecodeError ||
    error instanceof GitHubOperationListingError ||
    error instanceof GitHubConfigMalformedError ||
    error instanceof GitHubConfigDataError ||
    error instanceof GitHubPlaintextConfigError ||
    error instanceof CommitVerificationError ||
    error instanceof InvalidBatchError ||
    error instanceof ImmutablePathConflictError
  ) {
    return "remoteCorrupt";
  }
  if (error instanceof GitHubBranchMissingError) {
    return "remoteMissing";
  }
  if (
    error instanceof GitHubEmptyRepositoryError ||
    error instanceof GitHubConfigNotInitializedError
  ) {
    return "remoteMissing";
  }
  if (error instanceof GitHubPublicRepositoryError) {
    return "unsupportedServer";
  }
  if (error instanceof GitHubRepositoryPermissionError) {
    return "permissionRequired";
  }
  if (error instanceof GitHubRedirectError) {
    return "unsupportedServer";
  }
  if (error instanceof RemoteOperationValidationError) {
    return "remoteCorrupt";
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return "offline";
  }
  return "error";
};
