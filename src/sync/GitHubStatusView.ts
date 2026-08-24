export interface GitHubStatusViewInput {
  connection?: unknown;
  storedStatus?: {
    status: string;
    updatedAt: number;
    lastSuccessfulSyncAt?: number;
  };
  hasToken: boolean;
  hasDataKey: boolean;
  details?: object;
}

export interface GitHubStatusView {
  status: string;
  configured: boolean;
  unlocked: boolean;
  tokenRequired: boolean;
  updatedAt: number;
  lastSuccessfulSyncAt?: number;
  details?: object;
}

const UNLOCKED_STATUSES = new Set([
  "testing",
  "initializing",
  "pending",
  "syncing",
  "synced",
  "conflict",
  "needsLocalUnlock",
  "permissionRequired",
  "authFailed",
  "rateLimited",
  "branchProtected",
  "repositoryChanged",
  "historyRewritten",
  "offline",
  "unsupportedServer",
  "remoteMissing",
  "remoteIncomplete",
  "remoteCorrupt",
  "error",
]);

/**
 * Maps persisted connection + session secrets onto the popup-facing status.
 * A stored connection is never reported as unconfigured just because the last
 * status write is missing or stale.
 */
export function resolveGitHubStatusView(
  input: GitHubStatusViewInput
): GitHubStatusView {
  const updatedAt = input.storedStatus?.updatedAt || 0;
  const lastSuccessfulSyncAt = input.storedStatus?.lastSuccessfulSyncAt;
  const details = input.details;
  if (!input.connection) {
    return {
      status: "unconfigured",
      configured: false,
      unlocked: false,
      tokenRequired: false,
      updatedAt,
      lastSuccessfulSyncAt,
    };
  }

  if (!input.hasToken) {
    return {
      status: "tokenRequired",
      configured: true,
      unlocked: false,
      tokenRequired: true,
      updatedAt,
      lastSuccessfulSyncAt,
      details,
    };
  }

  if (!input.hasDataKey) {
    return {
      status: "needsSyncPassword",
      configured: true,
      unlocked: false,
      tokenRequired: false,
      updatedAt,
      lastSuccessfulSyncAt,
      details,
    };
  }

  const stored = input.storedStatus?.status;
  const status = stored && UNLOCKED_STATUSES.has(stored) ? stored : "pending";
  return {
    status,
    configured: true,
    unlocked: true,
    tokenRequired: false,
    updatedAt,
    lastSuccessfulSyncAt,
    details,
  };
}

export function githubSecretFields(state: {
  configured: boolean;
  unlocked: boolean;
  tokenRequired: boolean;
  hasRemoteConfig: boolean;
}) {
  return {
    showPat: !state.configured || state.tokenRequired,
    showPassword: !state.unlocked,
    showConfirmation: !state.configured && !state.hasRemoteConfig,
    showConnectOrUnlock: !state.unlocked,
  };
}
