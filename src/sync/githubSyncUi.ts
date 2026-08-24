import { encodeBase64 } from "./Base64";
import {
  createEncryptedRepositoryConfig,
  EncryptedRepositoryConfig,
  parseRepositoryConfig,
  verifyRepositoryAccess,
} from "./RepositoryConfig";
import { encodeRepositoryKekMessage } from "./SyncMessage";
import { Argon2idKdfConfig } from "./SyncCrypto";
import { validateOwner, validateRepository } from "./github/GitHubApiClient";
import { GITHUB_SYNC_BRANCH } from "./github/GitHubRepository";

/**
 * Popup-facing GitHub sync helpers. These functions are intentionally pure
 * (no direct `chrome.*` calls except where a seam is injected) so the connect
 * flow, request action names, mandatory encryption, secret clearing, the
 * config-race retry, and the background-alarm wiring can be unit-tested
 * without a network, a real PAT, or the Argon2 sandbox.
 */

export const GITHUB_API_ORIGIN_PATTERN = "https://api.github.com/*";
export const GITHUB_SYNC_BRANCH_DISPLAY = GITHUB_SYNC_BRANCH;
export const GITHUB_SYNC_ALARM = "github-sync";
export const MIN_BACKGROUND_MINUTES = 5;
export const DEFAULT_BACKGROUND_MINUTES = 15;
export const SYNC_PASSWORD_STORAGE_KEY = "githubSyncPassword";
export const SYNC_TOKEN_STORAGE_KEY = "githubSyncToken";
const MAX_TOKEN_LENGTH = 4096;

/** Boundary for the independently generated Argon2id config at first create. */
export function createBoundedKdf(): Argon2idKdfConfig {
  return {
    name: "argon2id",
    salt: encodeBase64(crypto.getRandomValues(new Uint8Array(16))),
    time: 2,
    memoryKiB: 19456,
    parallelism: 1,
    hashLength: 32,
  };
}

export function isValidGithubIdentity(owner: string, repository: string) {
  try {
    validateOwner(owner);
    validateRepository(repository);
    return true;
  } catch {
    return false;
  }
}

/** Validated https://github.com/{owner}/{repository} URL for the Open button. */
export function githubRepositoryUrl(owner: string, repository: string) {
  if (!isValidGithubIdentity(owner, repository)) {
    throw new Error("GitHub repository URL is invalid");
  }
  return `https://github.com/${owner}/${repository}`;
}

export function normalizeBackgroundMinutes(value: unknown) {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes < MIN_BACKGROUND_MINUTES) {
    return DEFAULT_BACKGROUND_MINUTES;
  }
  return minutes;
}

export interface BackgroundSettings {
  enabled: boolean;
  minutes: number;
}

/** Reads githubBackgroundSyncEnabled / githubBackgroundSyncMinutes storage. */
export function readBackgroundSettings(
  values: Record<string, unknown>
): BackgroundSettings {
  return {
    enabled: values.githubBackgroundSyncEnabled === true,
    minutes: normalizeBackgroundMinutes(values.githubBackgroundSyncMinutes),
  };
}

export interface AlarmCommand {
  name: string;
  create: boolean;
  minutes: number;
}

/** Pure seam: which alarm command the toggle/interval translate into. */
export function alarmCommand(enabled: boolean, minutes: number): AlarmCommand {
  const normalized = normalizeBackgroundMinutes(minutes);
  return {
    name: GITHUB_SYNC_ALARM,
    create: enabled,
    minutes: normalized,
  };
}

export interface ConnectionSecrets {
  pat: string;
  syncPassword: string;
  syncPasswordConfirmation: string;
}

/** Always clear the PAT, sync password, and confirmation after any attempt. */
export function emptyConnectionSecrets(): ConnectionSecrets {
  return { pat: "", syncPassword: "", syncPasswordConfirmation: "" };
}

export interface PopupGitHubStatus {
  status: string;
  configured: boolean;
  unlocked: boolean;
  tokenRequired: boolean;
  lastSuccessfulSyncAt?: number;
  details?: object;
}

/**
 * Merges a status broadcast or getStatus snapshot into the popup.
 * Broadcasts omit `configured` and must not flip a live connection off.
 * A full snapshot with configured:false is applied consistently, including
 * status, so the UI cannot stay on "syncing" after the connection is gone.
 */
export function applyIncomingGitHubStatus(
  current: PopupGitHubStatus,
  incoming: {
    status?: string;
    configured?: boolean;
    unlocked?: boolean;
    tokenRequired?: boolean;
    lastSuccessfulSyncAt?: number;
    details?: object;
  }
): PopupGitHubStatus {
  const next: PopupGitHubStatus = { ...current };
  if (typeof incoming.configured === "boolean") {
    next.configured = incoming.configured;
    if (typeof incoming.status === "string") {
      next.status = incoming.status;
    }
    if (typeof incoming.unlocked === "boolean") {
      next.unlocked = incoming.unlocked;
    }
    if (typeof incoming.tokenRequired === "boolean") {
      next.tokenRequired = incoming.tokenRequired;
    }
  } else if (
    typeof incoming.status === "string" &&
    !(incoming.status === "unconfigured" && current.configured)
  ) {
    next.status = incoming.status;
  }
  if (typeof incoming.lastSuccessfulSyncAt === "number") {
    next.lastSuccessfulSyncAt = incoming.lastSuccessfulSyncAt;
  }
  if (incoming.details) {
    next.details = incoming.details;
  }
  return next;
}

export function readStoredSyncPassword(
  localValues: Record<string, unknown>,
  sessionValues: Record<string, unknown> = {}
): string {
  return readStoredSecret(
    SYNC_PASSWORD_STORAGE_KEY,
    localValues,
    sessionValues
  );
}

export function readStoredSyncToken(
  localValues: Record<string, unknown>,
  sessionValues: Record<string, unknown> = {}
): string {
  return readStoredSecret(SYNC_TOKEN_STORAGE_KEY, localValues, sessionValues);
}

function readStoredSecret(
  key: string,
  localValues: Record<string, unknown>,
  sessionValues: Record<string, unknown>
): string {
  for (const values of [localValues, sessionValues]) {
    const value = values[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

export interface SyncPasswordPersistPlan {
  local?: string;
  session?: string;
  removeLocal: boolean;
  removeSession: boolean;
}

/** Where the sync password should live after a successful connect/unlock. */
export function syncPasswordPersistPlan(
  password: string,
  remember: boolean
): SyncPasswordPersistPlan {
  if (remember && password.length > 0) {
    return {
      local: password,
      removeLocal: false,
      removeSession: true,
    };
  }
  if (password.length > 0) {
    return {
      session: password,
      removeLocal: true,
      removeSession: false,
    };
  }
  return { removeLocal: true, removeSession: true };
}

export interface GitHubInspectRequestInput {
  owner: string;
  repository: string;
  token: string;
  rememberToken: boolean;
  rememberPassword?: boolean;
}

export interface GitHubConnectRequestPayload extends GitHubInspectRequestInput {
  candidate?: EncryptedRepositoryConfig;
  kek?: Uint8Array;
}

/**
 * Builds the inner githubConnect request. The candidate is encrypted-only and
 * always requires a KEK; the KEK is carried as strict Base64 via
 * encodeRepositoryKekMessage so the raw sync password is never sent.
 */
export function buildGitHubConnectRequest(
  input: GitHubConnectRequestPayload
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    owner: input.owner,
    repository: input.repository,
    token: input.token,
    rememberToken: input.rememberToken === true,
    rememberPassword: input.rememberPassword !== false,
    branch: GITHUB_SYNC_BRANCH,
  };
  if (input.candidate) {
    if (input.candidate.encryption.mode !== "aes-256-gcm") {
      throw new Error("GitHub candidate config must be encrypted");
    }
    if (!input.kek) {
      throw new Error("An encrypted candidate config requires a KEK");
    }
    request.candidate = input.candidate;
  }
  if (input.kek) {
    request.kek = encodeRepositoryKekMessage(input.kek);
  }
  return request;
}

export function buildGitHubInspectRequest(
  input: GitHubInspectRequestInput
): Record<string, unknown> {
  return {
    owner: input.owner,
    repository: input.repository,
    token: input.token,
    rememberToken: input.rememberToken === true,
    rememberPassword: input.rememberPassword !== false,
    branch: GITHUB_SYNC_BRANCH,
  };
}

/**
 * Strictly parses an encrypted repository config returned from the runtime.
 * Fails closed on non-encrypted configs: plaintext sync is never an option.
 */
export function parseEncryptedConfig(
  value: unknown
): EncryptedRepositoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub repository config is invalid");
  }
  const parsed = parseRepositoryConfig(JSON.stringify(value));
  if (parsed.encryption.mode !== "aes-256-gcm") {
    throw new Error("GitHub repository config must be encrypted");
  }
  return parsed as EncryptedRepositoryConfig;
}

/** The winning config published by another device during a config race. */
export function parseRaceConfig(value: unknown): EncryptedRepositoryConfig {
  return parseEncryptedConfig(value);
}

/**
 * Runtime request action names. Keeping these builders in one place lets the
 * UI and the tests share (and verify) the exact message shapes.
 */
export function githubInspectMessage(request: unknown) {
  return { action: "githubInspect", request };
}
export function githubConnectMessage(request: unknown) {
  return { action: "githubConnect", request };
}
export function githubInspectStoredMessage() {
  return { action: "githubInspectStored" };
}
export function githubUnlockMessage(
  kek: Uint8Array,
  rememberPassword?: boolean
) {
  return {
    action: "githubUnlock",
    kek: encodeRepositoryKekMessage(kek),
    rememberPassword: rememberPassword !== false,
  };
}
export function githubGetStatusMessage() {
  return { action: "githubGetStatus" };
}

/** Starts popup-triggered sync without delaying the first Vue render. */
export function triggerGithubPopupSync(
  sendMessage: (message: { action: string }) => Promise<unknown>
): void {
  void sendMessage({ action: "githubSyncPopup" }).catch(() => undefined);
}
export function githubGetConflictsMessage() {
  return { action: "githubGetConflicts" };
}
export function githubResolveConflictMessage(command: unknown) {
  return { action: "githubResolveConflict", command };
}
export function githubSyncManualMessage() {
  return { action: "githubSyncManual" };
}
export function githubRepairLegacyPathsMessage() {
  return { action: "githubRepairLegacyPaths" };
}
export function githubDisconnectMessage() {
  return { action: "githubDisconnect" };
}
export function githubForgetRepositoryMessage() {
  return { action: "githubForgetRepository" };
}

const HEALTHY_STATUSES = new Set([
  "unconfigured",
  "testing",
  "initializing",
  "pending",
  "syncing",
  "synced",
  "conflict",
]);

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  [
    "unconfigured",
    "testing",
    "initializing",
    "pending",
    "syncing",
    "synced",
    "conflict",
    "needsLocalUnlock",
    "needsSyncPassword",
    "permissionRequired",
    "tokenRequired",
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
    "repaired",
    "noRepairNeeded",
  ].map((status) => [status, `github_state_${status}`])
);

export function statusLabelKey(status: string): string {
  return STATUS_LABELS[status] || "github_state_error";
}

const STATUS_MESSAGES: Record<string, string> = {
  tokenRequired: "github_status_token_required",
  needsSyncPassword: "github_status_needs_sync_password",
  rateLimited: "github_status_rate_limited",
  branchProtected: "github_status_branch_protected",
  historyRewritten: "github_status_history_rewritten",
  repositoryChanged: "github_status_repository_changed",
  remoteMissing: "github_status_remote_missing",
  permissionRequired: "github_status_permission_required",
  authFailed: "github_status_auth_failed",
  offline: "github_status_offline",
  unsupportedServer: "github_status_unsupported_server",
  remoteCorrupt: "github_status_remote_corrupt",
  error: "github_status_generic_error",
};

/**
 * Maps a backend/UI status to its i18n message key. Unknown statuses always
 * fall back to the generic setup message so a surprising server status can
 * never surface raw text (which could embed a PAT) into the UI.
 */
export function statusMessageKey(status: string): string {
  if (HEALTHY_STATUSES.has(status)) {
    return "";
  }
  return STATUS_MESSAGES[status] || "github_status_generic_error";
}

/**
 * Safe generic setup error. The original error (which may carry a PAT or raw
 * server body) is intentionally ignored: it is never echoed, and nothing is
 * logged to the console.
 */
export function genericSetupError(
  _error: unknown,
  localizedMessage?: string
): string {
  // Intentionally consumed without interpolation: the original error (which
  // may carry a PAT or a raw server body) must never be surfaced or logged.
  void _error;
  if (localizedMessage) {
    return localizedMessage;
  }
  try {
    if (typeof chrome !== "undefined" && chrome.i18n?.getMessage) {
      const translated = chrome.i18n.getMessage("github_status_generic_error");
      if (translated) {
        return translated;
      }
    }
  } catch {
    // Tests and the standalone PWA may not expose chrome.i18n.
  }
  return (
    "GitHub sync setup failed. Check the repository name, token " +
    "permissions, and network connection, then try again."
  );
}

export interface GithubConnectDeps {
  requestPermission(origin: string): Promise<boolean>;
  inspect(request: unknown): Promise<Record<string, unknown>>;
  connect(request: unknown): Promise<Record<string, unknown>>;
  deriveKek(password: string, kdf: Argon2idKdfConfig): Promise<Uint8Array>;
  generateKdf(): Argon2idKdfConfig;
}

export interface GithubConnectInput extends GitHubInspectRequestInput {
  syncPassword: string;
  syncPasswordConfirmation: string;
  /** True when a connection already exists (reconnect path). */
  configured: boolean;
  /** True on the reconnect path when a PAT must be supplied. */
  tokenRequired: boolean;
}

export type GithubConnectStatus =
  | "success"
  | "permissionRequired"
  | "needsSyncPassword"
  | "tokenRequired"
  | "authFailed"
  | "offline"
  | "unsupportedServer"
  | "remoteMissing"
  | "remoteCorrupt"
  | "rateLimited"
  | "branchProtected"
  | "historyRewritten"
  | "repositoryChanged"
  | "error"
  | "invalidIdentity"
  | "missingToken"
  | "passwordMismatch"
  | "configRaceFailed";

export interface GithubConnectOutcome {
  status: GithubConnectStatus;
  errorKey?: string;
}

/**
 * The complete popup connect flow: permission, inspect, KEK derivation /
 * candidate generation, connect, and a single config-race retry. All secrets
 * (PAT, sync password, confirmation, KEK) are local to the call and are never
 * logged or returned.
 */
export async function runGithubConnect(
  deps: GithubConnectDeps,
  input: GithubConnectInput
): Promise<GithubConnectOutcome> {
  if (!isValidGithubIdentity(input.owner, input.repository)) {
    return {
      status: "invalidIdentity",
      errorKey: "github_error_invalid_identity",
    };
  }

  const needsToken = input.tokenRequired || !input.configured;
  if (
    needsToken &&
    (typeof input.token !== "string" ||
      input.token.length === 0 ||
      input.token.length > MAX_TOKEN_LENGTH)
  ) {
    return { status: "missingToken", errorKey: "github_error_missing_token" };
  }

  const granted = await deps.requestPermission(GITHUB_API_ORIGIN_PATTERN);
  if (!granted) {
    return { status: "permissionRequired" };
  }

  const inspected = await deps.inspect(buildGitHubInspectRequest(input));
  const inspectionFailure = classifiedFailure(inspected?.status);
  if (inspectionFailure) {
    return inspectionFailure;
  }

  const remoteConfig = inspected?.config
    ? parseEncryptedConfig(inspected.config)
    : undefined;

  if (remoteConfig) {
    return connectAgainstExisting(deps, input, remoteConfig);
  }
  if (input.configured) {
    // A configured repository cannot lose its encrypted config; treat the
    // missing branch/config as a remote problem.
    return { status: "remoteMissing" };
  }
  return createFirstConfig(deps, input);
}

async function connectAgainstExisting(
  deps: GithubConnectDeps,
  input: GithubConnectInput,
  config: EncryptedRepositoryConfig
): Promise<GithubConnectOutcome> {
  if (
    typeof input.syncPassword !== "string" ||
    input.syncPassword.length === 0
  ) {
    return { status: "needsSyncPassword" };
  }
  const kek = await deps.deriveKek(input.syncPassword, config.encryption.kdf);
  try {
    // Verify locally before any remote write; a wrong password becomes an
    // actionable "sync password" message instead of a raw server round trip.
    try {
      await verifyRepositoryAccess(config, kek);
    } catch {
      return { status: "needsSyncPassword" };
    }
    return await connectOnce(
      deps,
      input,
      buildGitHubConnectRequest({
        owner: input.owner,
        repository: input.repository,
        token: input.token,
        rememberToken: input.rememberToken,
        kek,
      })
    );
  } finally {
    kek.fill(0);
  }
}

async function createFirstConfig(
  deps: GithubConnectDeps,
  input: GithubConnectInput
): Promise<GithubConnectOutcome> {
  if (
    typeof input.syncPassword !== "string" ||
    input.syncPassword.length === 0
  ) {
    return {
      status: "needsSyncPassword",
      errorKey: "github_error_create_password",
    };
  }
  if (input.syncPassword !== input.syncPasswordConfirmation) {
    return {
      status: "passwordMismatch",
      errorKey: "github_error_password_mismatch",
    };
  }
  const kdf = deps.generateKdf();
  const kek = await deps.deriveKek(input.syncPassword, kdf);
  try {
    // createEncryptedRepositoryConfig is the only creation path: plaintext
    // candidates are never generated here.
    const { config: candidate } = await createEncryptedRepositoryConfig(
      kdf,
      kek
    );
    return await connectOnce(
      deps,
      input,
      buildGitHubConnectRequest({
        owner: input.owner,
        repository: input.repository,
        token: input.token,
        rememberToken: input.rememberToken,
        candidate,
        kek,
      })
    );
  } finally {
    kek.fill(0);
  }
}

function connectOnce(
  deps: GithubConnectDeps,
  input: GithubConnectInput,
  request: Record<string, unknown>
): Promise<GithubConnectOutcome> {
  return handleConnectResult(deps, input, request, false);
}

const CLASSIFIED_FAILURE_STATUSES = new Set<GithubConnectStatus>([
  "permissionRequired",
  "needsSyncPassword",
  "tokenRequired",
  "authFailed",
  "offline",
  "unsupportedServer",
  "remoteMissing",
  "remoteCorrupt",
  "rateLimited",
  "branchProtected",
  "historyRewritten",
  "repositoryChanged",
  "error",
]);

function classifiedFailure(status: unknown): GithubConnectOutcome | undefined {
  if (
    typeof status === "string" &&
    CLASSIFIED_FAILURE_STATUSES.has(status as GithubConnectStatus)
  ) {
    return { status: status as GithubConnectStatus };
  }
  return undefined;
}

async function handleConnectResult(
  deps: GithubConnectDeps,
  input: GithubConnectInput,
  request: Record<string, unknown>,
  alreadyRetried: boolean
): Promise<GithubConnectOutcome> {
  const result = await deps.connect(request);
  const connectionFailure = classifiedFailure(result?.status);
  if (connectionFailure) {
    return connectionFailure;
  }
  if (result?.status === "configRace") {
    if (alreadyRetried) {
      return {
        status: "configRaceFailed",
        errorKey: "github_error_config_race",
      };
    }
    return retryAfterRace(deps, input, result);
  }
  if (result?.status === "initializing") {
    return { status: "success" };
  }
  return {
    status: "configRaceFailed",
    errorKey: "github_status_generic_error",
  };
}

/**
 * A concurrent device won the branch with a different sync password / KDF
 * salt. Re-derive against the published winner config with the same entered
 * password and retry githubConnect once without a candidate. A second race
 * (or a wrong password for the winner config) becomes an actionable error.
 */
async function retryAfterRace(
  deps: GithubConnectDeps,
  input: GithubConnectInput,
  race: Record<string, unknown>
): Promise<GithubConnectOutcome> {
  let winnerConfig: EncryptedRepositoryConfig;
  try {
    winnerConfig = parseRaceConfig(race.config);
  } catch {
    return { status: "configRaceFailed", errorKey: "github_error_config_race" };
  }
  if (
    typeof input.syncPassword !== "string" ||
    input.syncPassword.length === 0
  ) {
    return { status: "needsSyncPassword" };
  }
  const winnerKek = await deps.deriveKek(
    input.syncPassword,
    winnerConfig.encryption.kdf
  );
  try {
    try {
      await verifyRepositoryAccess(winnerConfig, winnerKek);
    } catch {
      return {
        status: "configRaceFailed",
        errorKey: "github_error_config_race",
      };
    }
    return await handleConnectResult(
      deps,
      input,
      buildGitHubConnectRequest({
        owner: input.owner,
        repository: input.repository,
        token: input.token,
        rememberToken: input.rememberToken,
        kek: winnerKek,
      }),
      true
    );
  } finally {
    winnerKek.fill(0);
  }
}
