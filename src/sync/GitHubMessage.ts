import { EncryptedRepositoryConfig } from "./RepositoryConfig";
import { validateOwner, validateRepository } from "./github/GitHubApiClient";
import { GITHUB_SYNC_BRANCH } from "./github/GitHubRepository";
import { GitHubConnectionRequest } from "./github/GitHubConnectionService";
import { decodeRepositoryKekMessage } from "./SyncMessage";

const MAX_TOKEN_LENGTH = 4096;

/**
 * Strictly parses the GitHub connect request carried over
 * chrome.runtime.sendMessage. Rejects a non-fixed branch, an unencrypted or
 * malformed candidate config, and an undersized PAT. The returned request
 * contains only the data needed by the connection flow; the PAT is carried in
 * memory and never logged or serialized into any persisted structure here.
 */
export function parseGitHubConnectRequest(
  value: unknown
): GitHubConnectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub connection request is invalid");
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.owner !== "string" ||
    typeof request.repository !== "string" ||
    typeof request.token !== "string"
  ) {
    throw new Error("GitHub connection request is invalid");
  }
  validateOwner(request.owner);
  validateRepository(request.repository);
  if (request.token.length === 0 || request.token.length > MAX_TOKEN_LENGTH) {
    throw new Error("GitHub token is invalid");
  }
  if (request.branch !== undefined && request.branch !== GITHUB_SYNC_BRANCH) {
    throw new Error(`GitHub sync branch is fixed to ${GITHUB_SYNC_BRANCH}`);
  }
  let candidate: EncryptedRepositoryConfig | undefined;
  if (request.candidate !== undefined && request.candidate !== null) {
    if (
      !request.candidate ||
      typeof request.candidate !== "object" ||
      Array.isArray(request.candidate)
    ) {
      throw new Error("GitHub candidate config is invalid");
    }
    const config = request.candidate as Record<string, unknown>;
    if (
      typeof config.encryption !== "object" ||
      config.encryption === null ||
      (config.encryption as Record<string, unknown>).mode !== "aes-256-gcm" ||
      typeof config.repositoryId !== "string"
    ) {
      throw new Error("GitHub candidate config is invalid");
    }
    candidate = request.candidate as EncryptedRepositoryConfig;
  }
  return {
    owner: request.owner,
    repository: request.repository,
    token: request.token,
    rememberToken: request.rememberToken === true,
    rememberPassword: request.rememberPassword !== false,
    branch: GITHUB_SYNC_BRANCH,
    candidate,
    kek:
      request.kek === undefined
        ? undefined
        : decodeRepositoryKekMessage(request.kek),
  };
}

export interface GitHubMessageRuntime {
  id: string;
  getURL(path: string): string;
}

/**
 * Rejects GitHub sync messages from senders outside the extension. Non-sync
 * actions are ignored. The PAT must never reach here; only the message action
 * is inspected.
 */
export function assertGitHubMessageTrusted(
  message: { action?: unknown },
  sender: { id?: string; url?: string },
  runtime: GitHubMessageRuntime
) {
  if (
    typeof message.action !== "string" ||
    !message.action.startsWith("github")
  ) {
    return;
  }
  const extensionRoot = runtime.getURL("");
  if (
    sender.id !== runtime.id ||
    (sender.url !== undefined && !sender.url.startsWith(extensionRoot))
  ) {
    throw new Error("Rejected an untrusted GitHub message sender");
  }
}
