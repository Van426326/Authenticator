import { accountWriteMutex } from "./AsyncMutex";
import { GitHubStatusView, resolveGitHubStatusView } from "./GitHubStatusView";
import { decodeBase64, encodeBase64 } from "./Base64";
import { AuthenticatorLocalAccountAdapter } from "./LocalAccountAdapter";
import { forceAccountStorageLocal } from "./LocalStorageMigration";
import { classifySyncError } from "./SyncError";
import { SyncConflictService } from "./SyncConflictService";
import { SyncCoordinator, SyncScheduler } from "./SyncCoordinator";
import { IndexedDbSyncJournal } from "./SyncJournal";
import {
  SyncMutationCommand,
  SyncMutationFactory,
} from "./SyncMutationFactory";
import {
  BackgroundSyncTriggers,
  SyncRequestTarget,
  SyncRunController,
  SyncRunResult,
  SyncRunner,
  SyncStatus,
  SyncStatusReporter,
  SyncTriggerReason,
} from "./SyncRunController";
import { GitHubApiClient, GitHubFetch } from "./github/GitHubApiClient";
import {
  GitHubConnectionInitializer,
  GitHubConnectionRecord,
  GitHubConnectionRequest,
  GitHubConnectionService,
  GitHubConnectionStore,
  GitHubConnectResult,
  GitHubInspectResult,
} from "./github/GitHubConnectionService";
import { GitHubCommitWriter } from "./github/GitHubCommitWriter";
import { GitHubOperationStore } from "./github/GitHubOperationStore";
import {
  GITHUB_SYNC_BRANCH,
  GitHubConfigNotInitializedError,
  GitHubPlaintextConfigError,
  GitHubRepository,
  GitHubRepositoryIdentityChangedError,
} from "./github/GitHubRepository";
import { openOperationEnvelope } from "./SyncCrypto";
import {
  EncryptedRepositoryConfig,
  repositoryConfigFingerprint,
  RepositoryPasswordError,
} from "./RepositoryConfig";
import {
  SyncEngine,
  SyncEngineJournal,
  SyncEngineLocalAdapter,
  SyncRepositorySession,
  SyncRepositorySessionProvider,
} from "./SyncEngine";

const GITHUB_API_ORIGIN_PATTERN = "https://api.github.com/*";
const CONNECTION_STORAGE_KEY = "githubSyncConnection";
const STATUS_STORAGE_KEY = "githubSyncStatus";
const DEVICE_ID_STORAGE_KEY = "githubDeviceId";
const SESSION_DATA_KEY = "githubRepositoryDataKey";
const TOKEN_STORAGE_KEY = "githubSyncToken";
const PASSWORD_STORAGE_KEY = "githubSyncPassword";
const DETAILS_STORAGE_KEY = "githubSyncDetails";
const BACKGROUND_ENABLED_KEY = "githubBackgroundSyncEnabled";
const BACKGROUND_MINUTES_KEY = "githubBackgroundSyncMinutes";
const ALARM_NAME = "github-sync";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Storage keys written by the previous WebDAV runtime. Cleared on disconnect
 * and forget so stale provider state can never resurrect a WebDAV transport.
 */
const LEGACY_WEBDAV_KEYS = [
  "webdavSyncConnection",
  "webdavSyncStatus",
  "webdavDeviceId",
  "webdavBackgroundSyncEnabled",
  "webdavBackgroundSyncMinutes",
];

export interface StoredSyncStatus {
  status: SyncStatus;
  updatedAt: number;
  lastSuccessfulSyncAt?: number;
}

/**
 * Bounded, secret-free sync snapshot. Only connection identity, the current
 * branch head, pending-operation counts, and safe GitHub API rate metadata are
 * recorded. It never contains the PAT, data key, sync password, remote response
 * bodies, or other account metadata.
 */
export interface GitHubSyncDetails {
  owner?: string;
  repository?: string;
  branch?: string;
  headSha?: string;
  headShortSha?: string;
  pendingOperations?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  /** Absent until the engine exposes a distinct pull timestamp. */
  lastPullAt?: number;
  /** Absent until the engine exposes a distinct push timestamp. */
  lastPushAt?: number;
}

export interface SyncLocalStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SyncSessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SyncPermissionChecker {
  containsOrigin(originPattern: string): Promise<boolean>;
}

export interface SyncStatusBroadcaster {
  broadcast(status: StoredSyncStatus): Promise<void>;
}

const chromeLocalStorage: SyncLocalStorage = {
  get: (key) => chrome.storage.local.get(key),
  set: (values) => chrome.storage.local.set(values),
  remove: (key) => chrome.storage.local.remove(key),
};

const chromeSessionStorage: SyncSessionStorage = {
  get: (key) => chrome.storage.session.get(key),
  set: (values) => chrome.storage.session.set(values),
  remove: (key) => chrome.storage.session.remove(key),
};

const chromePermissionChecker: SyncPermissionChecker = {
  containsOrigin: (originPattern) =>
    chrome.permissions.contains({ origins: [originPattern] }),
};

const chromeStatusBroadcaster: SyncStatusBroadcaster = {
  async broadcast(status) {
    try {
      await chrome.runtime.sendMessage({ action: "githubSyncStatus", status });
    } catch {
      // Popup and options pages are not always open.
    }
  },
};

function isConnection(value: unknown): value is GitHubConnectionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.formatVersion === 1 &&
    typeof candidate.owner === "string" &&
    candidate.owner.length > 0 &&
    candidate.owner.length <= 256 &&
    typeof candidate.repository === "string" &&
    candidate.repository.length > 0 &&
    candidate.repository.length <= 256 &&
    candidate.branch === GITHUB_SYNC_BRANCH &&
    typeof candidate.repositoryId === "string" &&
    UUID_V4.test(candidate.repositoryId) &&
    typeof candidate.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.fingerprint) &&
    candidate.mode === "aes-256-gcm" &&
    candidate.initialized === true &&
    typeof candidate.rememberToken === "boolean" &&
    (candidate.rememberPassword === undefined ||
      typeof candidate.rememberPassword === "boolean")
  );
}

/**
 * Validated persistence of the GitHub connection identity. Only identity
 * metadata is stored; the PAT, sync password, and repository data key never
 * enter this identity record.
 */
export class ChromeGitHubConnectionStore implements GitHubConnectionStore {
  private generation = 0;

  constructor(
    private readonly storage: SyncLocalStorage = chromeLocalStorage,
    private readonly ensureAccountStorageLocal: () => Promise<unknown> = () =>
      forceAccountStorageLocal()
  ) {}

  async get() {
    const values = await this.storage.get(CONNECTION_STORAGE_KEY);
    const connection = values[CONNECTION_STORAGE_KEY];
    if (connection === undefined || connection === null) {
      return undefined;
    }
    if (!isConnection(connection)) {
      throw new Error("Stored GitHub connection is invalid");
    }
    return connection;
  }

  ensureLocalAccountStorage() {
    return this.ensureAccountStorageLocal();
  }

  currentGeneration() {
    return this.generation;
  }

  isGenerationCurrent(generation: number) {
    return generation === this.generation;
  }

  private validate(connection: GitHubConnectionRecord) {
    if (!isConnection(connection)) {
      throw new Error("GitHub connection is invalid");
    }
  }

  async set(connection: GitHubConnectionRecord) {
    this.validate(connection);
    await this.ensureAccountStorageLocal();
    await this.storage.set({ [CONNECTION_STORAGE_KEY]: connection });
    this.generation += 1;
  }

  async setAfterLocalMigration(connection: GitHubConnectionRecord) {
    this.validate(connection);
    await this.storage.set({ [CONNECTION_STORAGE_KEY]: connection });
    this.generation += 1;
  }

  remove() {
    // Invalidate in-flight readers before the asynchronous storage deletion so
    // they cannot republish details after disconnect/forget has started.
    this.generation += 1;
    return this.storage.remove(CONNECTION_STORAGE_KEY);
  }
}

/**
 * Stores the PAT in chrome.storage.session by default and in
 * chrome.storage.local only when the user explicitly opts into rememberToken.
 * Setting one area always clears the other so a stale token cannot linger in
 * the wrong area. The token is kept out of chrome.storage.sync entirely.
 */
export class ChromeGitHubTokenStore {
  constructor(
    private readonly session: SyncSessionStorage = chromeSessionStorage,
    private readonly local: SyncLocalStorage = chromeLocalStorage
  ) {}

  async getToken(rememberToken?: boolean) {
    const preferred = rememberToken ? this.local : this.session;
    const fallback = rememberToken ? this.session : this.local;
    const fromPreferred = await this.readToken(preferred);
    if (fromPreferred !== undefined) {
      return fromPreferred;
    }
    return this.readToken(fallback);
  }

  private async readToken(
    area: SyncSessionStorage | SyncLocalStorage
  ): Promise<string | undefined> {
    const values = await area.get(TOKEN_STORAGE_KEY);
    const token = values[TOKEN_STORAGE_KEY];
    if (token === undefined || token === null) {
      return undefined;
    }
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Stored GitHub token is invalid");
    }
    return token;
  }

  async setToken(token: string, rememberToken: boolean) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("GitHub token is invalid");
    }
    const persisted = { [TOKEN_STORAGE_KEY]: token };
    if (rememberToken) {
      await this.local.set(persisted);
      await this.session.remove(TOKEN_STORAGE_KEY);
    } else {
      await this.session.set(persisted);
      await this.local.remove(TOKEN_STORAGE_KEY);
    }
  }

  async removeToken() {
    await this.session.remove(TOKEN_STORAGE_KEY);
    await this.local.remove(TOKEN_STORAGE_KEY);
  }
}

export class ChromeSyncStatusReporter implements SyncStatusReporter {
  private lastSuccessfulSyncAt?: number;

  constructor(
    private readonly storage: SyncLocalStorage = chromeLocalStorage,
    private readonly broadcaster: SyncStatusBroadcaster = chromeStatusBroadcaster,
    private readonly now: () => number = Date.now
  ) {}

  async setStatus(status: SyncStatus) {
    if (this.lastSuccessfulSyncAt === undefined) {
      const existing = (await this.storage.get(STATUS_STORAGE_KEY))[
        STATUS_STORAGE_KEY
      ];
      if (
        existing &&
        typeof existing === "object" &&
        "lastSuccessfulSyncAt" in existing &&
        typeof existing.lastSuccessfulSyncAt === "number" &&
        Number.isSafeInteger(existing.lastSuccessfulSyncAt) &&
        existing.lastSuccessfulSyncAt >= 0
      ) {
        this.lastSuccessfulSyncAt = existing.lastSuccessfulSyncAt;
      }
    }
    const updatedAt = this.now();
    if (status === "synced" || status === "conflict") {
      this.lastSuccessfulSyncAt = updatedAt;
    }
    const stored: StoredSyncStatus = {
      status,
      updatedAt,
      ...(this.lastSuccessfulSyncAt === undefined
        ? {}
        : { lastSuccessfulSyncAt: this.lastSuccessfulSyncAt }),
    };
    await this.storage.set({ [STATUS_STORAGE_KEY]: stored });
    await this.broadcaster.broadcast(stored);
  }

  async reset() {
    this.lastSuccessfulSyncAt = undefined;
    await this.storage.remove(DETAILS_STORAGE_KEY);
    await this.storage.remove(STATUS_STORAGE_KEY);
    await this.setStatus("unconfigured");
  }
}

export class ChromeGitHubSessionKeyStore {
  constructor(
    private readonly session: SyncSessionStorage = chromeSessionStorage,
    private readonly local?: SyncLocalStorage
  ) {}

  async getDataKey() {
    const sessionKey = await this.readDataKey(this.session);
    if (sessionKey) {
      return sessionKey;
    }
    if (!this.local) {
      return undefined;
    }
    return this.readDataKey(this.local);
  }

  async setDataKey(dataKey?: Uint8Array, rememberUnlock = false) {
    if (dataKey === undefined) {
      await this.clear();
      return;
    }
    if (dataKey.byteLength !== 32) {
      throw new Error("Repository data key is invalid");
    }
    const persisted = { [SESSION_DATA_KEY]: encodeBase64(dataKey) };
    if (rememberUnlock && this.local) {
      await this.local.set(persisted);
      await this.session.remove(SESSION_DATA_KEY);
      return;
    }
    await this.session.set(persisted);
    if (this.local) {
      await this.local.remove(SESSION_DATA_KEY);
    }
  }

  async clear() {
    await this.session.remove(SESSION_DATA_KEY);
    if (this.local) {
      await this.local.remove(SESSION_DATA_KEY);
    }
  }

  private async readDataKey(
    area: SyncSessionStorage | SyncLocalStorage
  ): Promise<Uint8Array | undefined> {
    const values = await area.get(SESSION_DATA_KEY);
    const encoded = values[SESSION_DATA_KEY];
    if (encoded === undefined || encoded === null) {
      return undefined;
    }
    if (typeof encoded !== "string") {
      throw new Error("Stored repository data key is invalid");
    }
    const dataKey = decodeBase64(encoded);
    if (dataKey.byteLength !== 32) {
      throw new Error("Stored repository data key is invalid");
    }
    return dataKey;
  }
}

export class GitHubSyncRepositorySessionProvider
  implements SyncRepositorySessionProvider {
  constructor(
    private readonly connections: ChromeGitHubConnectionStore,
    private readonly sessionKeys: ChromeGitHubSessionKeyStore
  ) {}

  async getSession() {
    const connection = await this.connections.get();
    if (!connection) {
      throw new Error("GitHub synchronization is not configured");
    }
    return {
      repositoryId: connection.repositoryId,
      mode: "aes-256-gcm" as const,
      initialized: connection.initialized,
      dataKey: await this.sessionKeys.getDataKey(),
    };
  }
}

type StoredGitHubAccess =
  | { status: "unconfigured" }
  | { status: "permissionRequired" }
  | { status: "tokenRequired" }
  | {
      connection: GitHubConnectionRecord;
      client: GitHubApiClient;
      repository: GitHubRepository;
    };

/**
 * Resolves the stored connection, API host permission, and stored PAT. Never
 * touches the network itself; the returned repository performs the actual
 * read-only inspection.
 */
async function resolveStoredGitHubAccess(
  connections: ChromeGitHubConnectionStore,
  tokens: ChromeGitHubTokenStore,
  permissions: SyncPermissionChecker,
  fetchImpl: GitHubFetch
): Promise<StoredGitHubAccess> {
  const connection = await connections.get();
  if (!connection) {
    return { status: "unconfigured" };
  }
  if (!(await permissions.containsOrigin(GITHUB_API_ORIGIN_PATTERN))) {
    return { status: "permissionRequired" };
  }
  const token = await tokens.getToken(connection.rememberToken);
  if (!token) {
    return { status: "tokenRequired" };
  }
  const client = new GitHubApiClient({ token }, fetchImpl);
  return {
    connection,
    client,
    repository: new GitHubRepository(
      client,
      connection.owner,
      connection.repository,
      GITHUB_SYNC_BRANCH
    ),
  };
}

/**
 * Verifies that the remote encrypted config matches the stored identity
 * exactly (repository id, fingerprint, encryption mode). Returns undefined when
 * the branch holds no config; throws on identity/fingerprint/mode drift.
 */
async function verifyStoredConfig(
  connection: GitHubConnectionRecord,
  config: EncryptedRepositoryConfig | undefined
): Promise<EncryptedRepositoryConfig | undefined> {
  if (!config) {
    return undefined;
  }
  if (config.repositoryId !== connection.repositoryId) {
    throw new GitHubRepositoryIdentityChangedError();
  }
  const fingerprint = await repositoryConfigFingerprint(config);
  if (fingerprint !== connection.fingerprint) {
    throw new GitHubRepositoryIdentityChangedError();
  }
  if (config.encryption.mode !== "aes-256-gcm") {
    throw new GitHubPlaintextConfigError();
  }
  return config;
}

/**
 * Runs one GitHub synchronization pass. Every run first performs a read-only
 * inspection that enforces the fixed authenticator-sync branch, a private
 * repository, encrypted-only config, and an exact match of the stored
 * repository id, fingerprint, and mode before any operation is read or
 * applied. The engine then runs with a fail-closed remote history policy.
 */
export class ConfiguredGitHubSyncRunner implements SyncRunner {
  constructor(
    private readonly connections: ChromeGitHubConnectionStore,
    private readonly tokens: ChromeGitHubTokenStore,
    private readonly sessionKeys: ChromeGitHubSessionKeyStore,
    private readonly permissions: SyncPermissionChecker,
    private readonly journal: SyncEngineJournal,
    private readonly local: SyncEngineLocalAdapter,
    private readonly deviceId: string,
    private readonly fetchImpl: GitHubFetch = (input, init) =>
      globalThis.fetch(input, init),
    private readonly writeDetails?: (
      details: GitHubSyncDetails
    ) => Promise<void>
  ) {}

  async run(reasons: SyncTriggerReason[]): Promise<SyncRunResult> {
    const connectionGeneration = this.connections.currentGeneration();
    const access = await resolveStoredGitHubAccess(
      this.connections,
      this.tokens,
      this.permissions,
      this.fetchImpl
    );
    if ("status" in access) {
      return access;
    }
    const { connection, client, repository } = access;

    // Read-only inspection before any operation read or apply.
    const inspection = await repository.inspect();
    const config = await verifyStoredConfig(connection, inspection.config);
    if (!config) {
      return { status: "remoteMissing" };
    }

    const dataKey = await this.sessionKeys.getDataKey();
    const session: SyncRepositorySession = {
      repositoryId: connection.repositoryId,
      mode: "aes-256-gcm",
      initialized: connection.initialized,
      dataKey,
    };
    const engine = new SyncEngine(
      { getSession: async () => session },
      this.journal,
      new GitHubOperationStore(
        client,
        connection.owner,
        connection.repository,
        GITHUB_SYNC_BRANCH
      ),
      this.local,
      this.deviceId
    );
    const result = await engine.run(reasons);
    if (!(await this.connectionStillCurrent(connectionGeneration))) {
      return { status: await this.statusAfterInvalidation() };
    }
    await this.persistDetails(
      connection,
      client,
      inspection,
      connectionGeneration
    );
    if (!(await this.connectionStillCurrent(connectionGeneration))) {
      return { status: await this.statusAfterInvalidation() };
    }
    return result;
  }

  async repairLegacyOperationPaths() {
    const access = await resolveStoredGitHubAccess(
      this.connections,
      this.tokens,
      this.permissions,
      this.fetchImpl
    );
    if ("status" in access) {
      return access;
    }
    const { connection, client, repository } = access;
    const inspection = await repository.inspect();
    const config = await verifyStoredConfig(connection, inspection.config);
    if (!config) {
      return { status: "remoteMissing" as const };
    }
    const dataKey = await this.sessionKeys.getDataKey();
    if (!dataKey) {
      return { status: "needsSyncPassword" as const };
    }

    const store = new GitHubOperationStore(
      client,
      connection.owner,
      connection.repository,
      GITHUB_SYNC_BRANCH
    );
    const files = await store.listOperationFiles();
    const repairs = [];
    for (const file of files) {
      if (!file.sha) {
        throw new Error("Remote operation has no content address");
      }
      const envelope = await store.download(file.deviceId, file.opId, file.sha);
      const operation = await openOperationEnvelope(
        envelope,
        "aes-256-gcm",
        dataKey
      );
      if (
        operation.repositoryId !== connection.repositoryId ||
        operation.opId !== file.opId
      ) {
        throw new Error("Remote operation path does not match its payload");
      }
      if (operation.deviceId !== file.deviceId) {
        repairs.push({
          opId: file.opId,
          fromDeviceId: file.deviceId,
          toDeviceId: operation.deviceId,
          sha: file.sha,
        });
      }
    }
    if (repairs.length === 0) {
      return { status: "noRepairNeeded" as const, repaired: 0 };
    }
    const writer = new GitHubCommitWriter(
      client,
      connection.owner,
      connection.repository,
      GITHUB_SYNC_BRANCH
    );
    for (let offset = 0; offset < repairs.length; offset += 50) {
      await writer.repairLegacyOperationPaths(
        repairs.slice(offset, offset + 50)
      );
    }
    await this.persistDetails(connection, client, await repository.inspect());
    return { status: "repaired" as const, repaired: repairs.length };
  }

  private async connectionStillCurrent(generation: number) {
    return this.connections.isGenerationCurrent(generation);
  }

  private async statusAfterInvalidation(): Promise<"unconfigured" | "pending"> {
    try {
      return (await this.connections.get()) ? "pending" : "unconfigured";
    } catch {
      return "pending";
    }
  }

  private async persistDetails(
    connection: GitHubConnectionRecord,
    client: GitHubApiClient,
    inspection: Awaited<ReturnType<GitHubRepository["inspect"]>>,
    connectionGeneration = this.connections.currentGeneration()
  ) {
    if (!this.writeDetails) {
      return;
    }
    try {
      const headSha = inspection.branchHeadSha;
      const rateLimit = client.getLastResponseMeta()?.rateLimit;
      const pendingOperations =
        (await this.journal.listOutbox(connection.repositoryId)).length +
        (await this.journal.listDirtyIntents(connection.repositoryId)).length;
      const details: GitHubSyncDetails = {
        owner: connection.owner,
        repository: connection.repository,
        branch: GITHUB_SYNC_BRANCH,
        ...(headSha ? { headSha, headShortSha: headSha.slice(0, 7) } : {}),
        pendingOperations,
        ...(rateLimit?.remaining !== undefined
          ? { rateLimitRemaining: rateLimit.remaining }
          : {}),
        ...(rateLimit?.reset !== undefined
          ? { rateLimitReset: rateLimit.reset }
          : {}),
      };
      if (!this.connections.isGenerationCurrent(connectionGeneration)) {
        return;
      }
      await this.writeDetails(details);
    } catch {
      // A snapshot write must never fail the sync run.
    }
  }
}

class MutationSyncScheduler implements SyncScheduler {
  constructor(
    private readonly reporter: SyncStatusReporter,
    private readonly target: () => BackgroundSyncTriggers
  ) {}

  async markPending() {
    await this.reporter.setStatus("pending");
  }

  schedule(delayMs: number) {
    if (delayMs !== 5000) {
      throw new Error("Local synchronization debounce must be five seconds");
    }
    this.target().localChange();
  }
}

export type GitHubInspectRuntimeResult = GitHubInspectResult | SyncRunResult;

export type GitHubConnectRuntimeResult = GitHubConnectResult | SyncRunResult;

/**
 * Read-only inspection of the already-stored connection. The encrypted config
 * is returned only after strict private/AES/identity verification; the PAT is
 * never part of the result.
 */
export type GitHubInspectStoredResult =
  | SyncRunResult
  | {
      status: "existing";
      owner: string;
      repository: string;
      branch: string;
      config: EncryptedRepositoryConfig;
    };

export type GitHubUnlockResult = SyncRunResult | { status: "unlocked" };

export interface BackgroundSyncRuntime {
  request: SyncRequestTarget;
  triggers: BackgroundSyncTriggers;
  coordinator: SyncCoordinator;
  reporter: SyncStatusReporter;
  mutate(command: SyncMutationCommand): Promise<boolean>;
  inspect(
    request: GitHubConnectionRequest
  ): Promise<GitHubInspectRuntimeResult>;
  connect(
    request: GitHubConnectionRequest
  ): Promise<GitHubConnectRuntimeResult>;
  /**
   * Read-only stored-connection inspection. Never exposes the PAT.
   */
  inspectStored(): Promise<GitHubInspectStoredResult>;
  getStatus(): Promise<GitHubStatusView>;
  /**
   * Unlocks the stored repository with a strictly decoded 32-byte KEK and
   * persists the returned data key in local or session storage.
   */
  unlock(
    kek: Uint8Array,
    rememberPassword?: boolean
  ): Promise<GitHubUnlockResult>;
  disconnect(): Promise<void>;
  forgetRepository(): Promise<void>;
  repairLegacyOperationPaths(): Promise<
    SyncRunResult | { status: "repaired" | "noRepairNeeded"; repaired: number }
  >;
  listConflicts(): Promise<unknown>;
  resolveConflict(command: {
    entityType: "otp" | "order";
    entityId: string;
    deleted: boolean;
    payload?: unknown;
  }): Promise<boolean>;
}

async function getOrCreateDeviceId(storage: SyncLocalStorage) {
  const values = await storage.get(DEVICE_ID_STORAGE_KEY);
  const existing = values[DEVICE_ID_STORAGE_KEY];
  if (typeof existing === "string" && UUID_V4.test(existing)) {
    return existing;
  }
  if (existing !== undefined && existing !== null) {
    throw new Error("Stored GitHub device id is invalid");
  }
  const deviceId = crypto.randomUUID();
  await storage.set({ [DEVICE_ID_STORAGE_KEY]: deviceId });
  return deviceId;
}

async function clearBackgroundAlarmAndSettings(
  storage: SyncLocalStorage,
  alarms: { clear(name: string): Promise<unknown> }
) {
  await alarms.clear(ALARM_NAME);
  await storage.remove(BACKGROUND_ENABLED_KEY);
  await storage.remove(BACKGROUND_MINUTES_KEY);
}

async function removeLegacyWebDavKeys(storage: SyncLocalStorage) {
  for (const key of LEGACY_WEBDAV_KEYS) {
    await storage.remove(key);
  }
}

export async function createBackgroundSyncRuntime(
  storage: SyncLocalStorage = chromeLocalStorage,
  alarms: { clear(name: string): Promise<unknown> } = chrome.alarms,
  permissions: SyncPermissionChecker = chromePermissionChecker,
  tokenStore: ChromeGitHubTokenStore = new ChromeGitHubTokenStore(),
  keyStore: ChromeGitHubSessionKeyStore = new ChromeGitHubSessionKeyStore(
    chromeSessionStorage,
    chromeLocalStorage
  )
): Promise<BackgroundSyncRuntime> {
  const deviceId = await getOrCreateDeviceId(storage);
  const reporter = new ChromeSyncStatusReporter(storage);
  const journal = new IndexedDbSyncJournal();
  const references: {
    coordinator?: SyncCoordinator;
    triggers?: BackgroundSyncTriggers;
  } = {};
  const seedWriter = {
    mutate(mutation: Parameters<SyncCoordinator["mutate"]>[0]) {
      if (!references.coordinator) {
        throw new Error("Sync coordinator is not initialized");
      }
      return references.coordinator.mutate(mutation);
    },
  };
  const connections = new ChromeGitHubConnectionStore(storage);
  const tokens = tokenStore;
  const sessionKeys = keyStore;
  const sessions = new GitHubSyncRepositorySessionProvider(
    connections,
    sessionKeys
  );
  const localAccounts = new AuthenticatorLocalAccountAdapter(
    undefined,
    undefined,
    seedWriter,
    sessions,
    deviceId
  );
  const runner = new ConfiguredGitHubSyncRunner(
    connections,
    tokens,
    sessionKeys,
    permissions,
    journal,
    localAccounts,
    deviceId,
    undefined,
    async (details) => {
      await storage.set({ [DETAILS_STORAGE_KEY]: details });
    }
  );
  const controller = new SyncRunController(runner, reporter, classifySyncError);
  const recoveringTarget: SyncRequestTarget = {
    async request(reason) {
      const connection = await connections.get();
      if (connection && references.coordinator) {
        try {
          await references.coordinator.recoverPending(connection.repositoryId);
        } catch (error) {
          await reporter.setStatus(classifySyncError(error));
          throw error;
        }
      }
      return controller.request(reason);
    },
  };
  const triggers = new BackgroundSyncTriggers(recoveringTarget);
  references.triggers = triggers;
  const coordinator = new SyncCoordinator(
    journal,
    localAccounts,
    new MutationSyncScheduler(reporter, () => {
      if (!references.triggers) {
        throw new Error("Sync triggers are not initialized");
      }
      return references.triggers;
    })
  );
  references.coordinator = coordinator;
  const mutationFactory = new SyncMutationFactory(
    connections,
    sessions,
    journal,
    deviceId
  );
  const connectionService = new GitHubConnectionService(
    new GitHubConnectionInitializer(),
    connections
  );
  const conflictService = new SyncConflictService(
    journal,
    sessions,
    localAccounts
  );
  const applyMutationCommand = (command: SyncMutationCommand) =>
    accountWriteMutex.runExclusive(async (permit) => {
      const mutation = await mutationFactory.create(command);
      if (!mutation) {
        return false;
      }
      await coordinator.mutate(mutation, permit);
      return true;
    });
  const connection = await connections.get();
  if (connection) {
    let recoveryFailed = false;
    try {
      await coordinator.recoverPending(connection.repositoryId);
    } catch (error) {
      recoveryFailed = true;
      await reporter.setStatus(classifySyncError(error));
    }
    const pending = [
      ...(await journal.listOutbox(connection.repositoryId)),
      ...(await journal.listDirtyIntents(connection.repositoryId)),
    ];
    if (!recoveryFailed && pending.length > 0) {
      await reporter.setStatus("pending");
    }
  }
  return {
    request: recoveringTarget,
    triggers,
    coordinator,
    reporter,
    mutate: applyMutationCommand,
    inspect: async (request) => {
      if (!(await permissions.containsOrigin(GITHUB_API_ORIGIN_PATTERN))) {
        return { status: "permissionRequired" };
      }
      try {
        return await connectionService.inspect(request);
      } catch (error) {
        return { status: classifySyncError(error) };
      }
    },
    async getStatus() {
      const stored = (await storage.get(STATUS_STORAGE_KEY))[
        STATUS_STORAGE_KEY
      ] as StoredSyncStatus | undefined;
      const details = (await storage.get(DETAILS_STORAGE_KEY))[
        DETAILS_STORAGE_KEY
      ] as GitHubSyncDetails | undefined;
      let connection;
      try {
        connection = await connections.get();
      } catch {
        return resolveGitHubStatusView({
          connection: true,
          storedStatus: stored,
          hasToken: false,
          hasDataKey: false,
          details,
        });
      }
      let hasToken = false;
      let hasDataKey = false;
      if (connection) {
        try {
          hasToken = Boolean(await tokens.getToken(connection.rememberToken));
        } catch {
          hasToken = false;
        }
        try {
          hasDataKey = Boolean(await sessionKeys.getDataKey());
        } catch {
          hasDataKey = false;
        }
      }
      return resolveGitHubStatusView({
        connection,
        storedStatus: stored,
        hasToken,
        hasDataKey,
        details,
      });
    },
    async inspectStored() {
      const connection = await connections.get();
      if (!connection) {
        return { status: "unconfigured" };
      }
      if (!(await permissions.containsOrigin(GITHUB_API_ORIGIN_PATTERN))) {
        return { status: "permissionRequired" };
      }
      const token = await tokens.getToken(connection.rememberToken);
      if (!token) {
        return { status: "tokenRequired" };
      }
      try {
        const result = await connectionService.inspect({
          owner: connection.owner,
          repository: connection.repository,
          token,
          branch: GITHUB_SYNC_BRANCH,
        });
        const config = await verifyStoredConfig(connection, result.config);
        if (!config) {
          return { status: "remoteMissing" };
        }
        return {
          status: "existing",
          owner: connection.owner,
          repository: connection.repository,
          branch: GITHUB_SYNC_BRANCH,
          config,
        };
      } catch (error) {
        return { status: classifySyncError(error) };
      }
    },
    async unlock(kek: Uint8Array, rememberPassword?: boolean) {
      const connection = await connections.get();
      if (!connection) {
        return { status: "unconfigured" };
      }
      if (!(await permissions.containsOrigin(GITHUB_API_ORIGIN_PATTERN))) {
        return { status: "permissionRequired" };
      }
      const token = await tokens.getToken(connection.rememberToken);
      if (!token) {
        return { status: "tokenRequired" };
      }
      let dataKey: Uint8Array | undefined;
      try {
        const initialized = await connectionService.verifyAndUnlock({
          owner: connection.owner,
          repository: connection.repository,
          token,
          branch: GITHUB_SYNC_BRANCH,
          kek,
          expectedRepositoryId: connection.repositoryId,
          expectedFingerprint: connection.fingerprint,
          expectedMode: connection.mode,
        });
        dataKey = initialized.access.dataKey;
      } catch (error) {
        if (error instanceof RepositoryPasswordError) {
          return { status: "needsSyncPassword" };
        }
        if (error instanceof GitHubConfigNotInitializedError) {
          return { status: "remoteMissing" };
        }
        return { status: classifySyncError(error) };
      }
      if (!dataKey) {
        // Encrypted configs always unwrap a 32-byte data key; fail closed
        // rather than ever clearing a stored key with an empty one.
        return { status: "error" };
      }
      // Persist the data key only on a verified replacement; a wrong KEK never
      // clears an existing valid session key. Do not touch the stored PAT.
      const persistUnlock =
        rememberPassword !== undefined
          ? rememberPassword
          : connection.rememberPassword !== false;
      try {
        await sessionKeys.setDataKey(dataKey, persistUnlock);
        if (
          rememberPassword !== undefined &&
          connection.rememberPassword !== persistUnlock
        ) {
          await connections.set({
            ...connection,
            rememberPassword: persistUnlock,
          });
        }
      } catch (error) {
        return { status: classifySyncError(error) };
      }
      // Trigger a background sync, fire-and-forget: the unlock response must not
      // depend on the full background run (which reads real storage and may take
      // longer than the message round-trip). Run errors are reported through the
      // status machine and must not fail the unlock itself.
      void triggers.immediate("manual").catch(() => undefined);
      return { status: "unlocked" };
    },
    async connect(request) {
      if (!(await permissions.containsOrigin(GITHUB_API_ORIGIN_PATTERN))) {
        return { status: "permissionRequired" };
      }
      let result: GitHubConnectResult;
      try {
        result = await connectionService.connect(request);
      } catch (error) {
        return { status: classifySyncError(error) };
      }
      if (result.status === "configRace") {
        // Nothing persisted; the popup re-derives against the winner config
        // and retries connect.
        return result;
      }
      try {
        await sessionKeys.setDataKey(
          result.dataKey,
          request.rememberPassword !== false
        );
        await tokens.setToken(request.token, request.rememberToken === true);
      } catch (error) {
        // The identity record is already durable. Clearing it here would make
        // a successful GitHub initialize look like "unconfigured" after the
        // popup reloads. Keep the connection and surface token/unlock retry.
        return { status: classifySyncError(error) };
      }
      // The status reporter owns any first-sync failure. Connection setup has
      // already completed, so do not turn an actionable sync state back into a
      // rejected runtime message and a generic popup error.
      void triggers.immediate("manual").catch(() => undefined);
      return result;
    },
    async disconnect() {
      controller.invalidate();
      triggers.cancelDebounce();
      await connectionService.disconnect();
      await tokens.removeToken();
      await sessionKeys.clear();
      await storage.remove(PASSWORD_STORAGE_KEY);
      await clearBackgroundAlarmAndSettings(storage, alarms);
      await removeLegacyWebDavKeys(storage);
      await reporter.reset();
    },
    async repairLegacyOperationPaths() {
      try {
        const result = await runner.repairLegacyOperationPaths();
        if (result.status === "repaired") {
          await reporter.setStatus("pending");
        }
        return result;
      } catch (error) {
        const status = classifySyncError(error);
        await reporter.setStatus(status);
        return { status };
      }
    },
    async forgetRepository() {
      controller.invalidate();
      triggers.cancelDebounce();
      const current = await connections.get();
      if (current) {
        await journal.deleteRepositoryData(current.repositoryId);
      }
      await connectionService.disconnect();
      await tokens.removeToken();
      await sessionKeys.clear();
      await storage.remove(PASSWORD_STORAGE_KEY);
      await clearBackgroundAlarmAndSettings(storage, alarms);
      await storage.remove(DEVICE_ID_STORAGE_KEY);
      await removeLegacyWebDavKeys(storage);
      await reporter.reset();
    },
    listConflicts: () => conflictService.list(),
    resolveConflict(command) {
      return applyMutationCommand({
        entityType: command.entityType,
        entityId: command.entityId,
        kind: "resolve",
        logicalPayload: command.deleted
          ? { resolution: "delete" }
          : { resolution: "upsert", entry: command.payload },
      });
    },
  };
}
