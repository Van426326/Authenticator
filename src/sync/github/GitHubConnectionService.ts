import { GitHubApiClient, GitHubFetch } from "./GitHubApiClient";
import { EncryptedRepositoryConfig } from "../RepositoryConfig";
import {
  GITHUB_SYNC_BRANCH,
  GitHubConfigRaceError,
  GitHubInitializedRepository,
  GitHubRepository,
  GitHubRepositoryIdentityChangedError,
  GitHubRepositoryInspection,
} from "./GitHubRepository";

export interface GitHubConnectionRecord {
  formatVersion: 1;
  owner: string;
  repository: string;
  branch: string;
  repositoryId: string;
  fingerprint: string;
  mode: "aes-256-gcm";
  initialized: true;
  /**
   * Whether the PAT is persisted in chrome.storage.local (`true`) or kept
   * session-only in chrome.storage.session (`false`). The token itself is
   * never written to this record or to browser sync storage.
   */
  rememberToken: boolean;
  /**
   * Whether the sync password and unwrapped repository data key are persisted
   * in chrome.storage.local (`true`) or kept session-only (`false`). The
   * password and data key themselves are never written to this record.
   */
  rememberPassword?: boolean;
}

/**
 * Persists only connection identity metadata. PATs, sync passwords, and the
 * repository data key must never reach this store; those secrets are returned
 * to the caller so they can be written to local or session storage.
 */
export interface GitHubConnectionStore {
  get(): Promise<GitHubConnectionRecord | undefined>;
  set(record: GitHubConnectionRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface GitHubConnectionRequest {
  owner: string;
  repository: string;
  token: string;
  branch?: string;
  rememberToken?: boolean;
  rememberPassword?: boolean;
  candidate?: EncryptedRepositoryConfig;
  kek?: Uint8Array;
  expectedRepositoryId?: string;
  expectedFingerprint?: string;
  expectedMode?: "aes-256-gcm";
}

export interface GitHubInspectResult {
  status: "unconfigured" | "existing";
  owner: string;
  repository: string;
  branch: string;
  config?: EncryptedRepositoryConfig;
}

export type GitHubConnectResult =
  | {
      /**
       * Another device initialized the repository with a different sync
       * password / KDF salt while this device was connecting. Nothing has
       * been persisted; the popup re-derives a KEK against the published
       * config and retries connect with that candidate.
       */
      status: "configRace";
      config: EncryptedRepositoryConfig;
    }
  | {
      status: "initializing";
      record: GitHubConnectionRecord;
      config: EncryptedRepositoryConfig;
      fingerprint: string;
      dataKey?: Uint8Array;
      created: boolean;
      rememberToken: boolean;
      rememberPassword: boolean;
    };

export interface GitHubConnectionRemote {
  inspect(
    request: GitHubConnectionRequest
  ): Promise<GitHubRepositoryInspection>;
  initialize(
    request: GitHubConnectionRequest
  ): Promise<GitHubInitializedRepository>;
}

/**
 * Builds the GitHub API client and repository from a connection request.
 * Owns the PAT only for the duration of the request lifecycle.
 */
export class GitHubConnectionInitializer implements GitHubConnectionRemote {
  constructor(
    private readonly fetchImpl: GitHubFetch = (input, init) =>
      globalThis.fetch(input, init)
  ) {}

  async inspect(
    request: GitHubConnectionRequest
  ): Promise<GitHubRepositoryInspection> {
    return this.buildRepository(request).inspect();
  }

  async initialize(
    request: GitHubConnectionRequest
  ): Promise<GitHubInitializedRepository> {
    const repository = this.buildRepository(request);
    return repository.initialize({
      candidate: request.candidate,
      kek: request.kek,
      expectedRepositoryId: request.expectedRepositoryId,
      expectedFingerprint: request.expectedFingerprint,
      expectedMode: request.expectedMode,
    });
  }

  private buildRepository(request: GitHubConnectionRequest) {
    return new GitHubRepository(
      new GitHubApiClient({ token: request.token }, this.fetchImpl),
      request.owner,
      request.repository,
      request.branch ?? GITHUB_SYNC_BRANCH
    );
  }
}

/**
 * Orchestrates the GitHub connection flow. Inspect is read-only and persists
 * nothing. Connect initializes or adopts the encrypted config and persists
 * only the identity record through the injected store; the repository data
 * key and PAT are returned/carried by the caller so they can be kept in
 * local or session storage. A concurrent-device config race (a different sync
 * password won the branch) is surfaced as `configRace` with the published
 * config and no persisted state.
 */
export class GitHubConnectionService {
  constructor(
    private readonly remote: GitHubConnectionRemote,
    private readonly store: GitHubConnectionStore
  ) {}

  async inspect(
    request: GitHubConnectionRequest
  ): Promise<GitHubInspectResult> {
    const inspected = await this.remote.inspect(request);
    return {
      status: inspected.config ? "existing" : "unconfigured",
      owner: request.owner,
      repository: request.repository,
      branch: inspected.repository.branch,
      config: inspected.config,
    };
  }

  /**
   * Read-only unlock verification for an already-stored connection. The caller
   * supplies the stored identity pins; the remote must hold an encrypted config
   * that the KEK unseals. Returns the initialized repository (with the data
   * key) so the caller can persist it in session storage. Never writes to the
   * store and never receives or returns a candidate, so a wrong KEK performs
   * zero remote writes.
   */
  async verifyAndUnlock(
    request: GitHubConnectionRequest
  ): Promise<GitHubInitializedRepository> {
    return this.remote.initialize({
      owner: request.owner,
      repository: request.repository,
      token: request.token,
      branch: request.branch,
      kek: request.kek,
      expectedRepositoryId: request.expectedRepositoryId,
      expectedFingerprint: request.expectedFingerprint,
      expectedMode: request.expectedMode,
    });
  }

  async connect(
    request: GitHubConnectionRequest
  ): Promise<GitHubConnectResult> {
    const stored = await this.store.get();
    const branch = request.branch ?? GITHUB_SYNC_BRANCH;
    if (stored) {
      if (
        stored.owner !== request.owner ||
        stored.repository !== request.repository ||
        stored.branch !== branch
      ) {
        throw new GitHubRepositoryIdentityChangedError();
      }
    }
    // The stored identity is authoritative for reconnects; request pins may not
    // weaken it.
    const pins = stored
      ? {
          expectedRepositoryId: stored.repositoryId,
          expectedFingerprint: stored.fingerprint,
          expectedMode: stored.mode,
        }
      : {
          expectedRepositoryId: request.expectedRepositoryId,
          expectedFingerprint: request.expectedFingerprint,
          expectedMode: request.expectedMode,
        };
    let initialized: GitHubInitializedRepository;
    try {
      initialized = await this.remote.initialize({ ...request, ...pins });
    } catch (error) {
      if (error instanceof GitHubConfigRaceError) {
        return { status: "configRace", config: error.config };
      }
      throw error;
    }
    const rememberToken = request.rememberToken === true;
    const rememberPassword = request.rememberPassword !== false;
    const record: GitHubConnectionRecord = {
      formatVersion: 1,
      owner: request.owner,
      repository: request.repository,
      branch: initialized.branch,
      repositoryId: initialized.access.repositoryId,
      fingerprint: initialized.access.fingerprint,
      mode: "aes-256-gcm",
      initialized: true,
      rememberToken,
      rememberPassword,
    };
    await this.store.set(record);
    return {
      status: "initializing",
      record,
      config: initialized.config,
      fingerprint: initialized.access.fingerprint,
      dataKey: initialized.access.dataKey,
      created: initialized.created,
      rememberToken,
      rememberPassword,
    };
  }

  async disconnect(): Promise<void> {
    await this.store.remove();
  }
}
