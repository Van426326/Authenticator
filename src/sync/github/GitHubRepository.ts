import {
  classifyGitHubError,
  encodeBranchRef,
  GitHubApiClient,
  GitHubHttpError,
  repoPath,
} from "./GitHubApiClient";
import { gitBlobSha } from "./GitBlobSha";
import { decodeGitHubBlobBase64 } from "./GitHubBase64";
import { encodeBase64 } from "../Base64";
import {
  EncryptedRepositoryConfig,
  parseRepositoryConfig,
  RepositoryAccess,
  RepositoryPasswordError,
  serializeRepositoryConfig,
  verifyRepositoryAccess,
} from "../RepositoryConfig";
import {
  BranchMovedError,
  BranchProtectedError,
  CommitVerificationError,
  isBranchProtectionRejection,
} from "./GitHubCommitWriter";

export const GITHUB_SYNC_BRANCH = "authenticator-sync";
export const GITHUB_CONFIG_PATH = "AuthenticatorSync/config.json";

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const MAX_META_JSON_BYTES = 1024 * 1024;
const MAX_CONFIG_BLOB_BYTES = 32 * 1024;
const DEFAULT_INITIALIZATION_ATTEMPTS = 5;
const INITIALIZATION_COMMIT_MESSAGE =
  "Authenticator sync: initialize repository";

export class GitHubPublicRepositoryError extends Error {
  constructor() {
    super("GitHub sync requires a private repository");
    this.name = "GitHubPublicRepositoryError";
  }
}

export class GitHubEmptyRepositoryError extends Error {
  constructor() {
    super(
      "The GitHub repository is empty. Initialize it with a README before connecting."
    );
    this.name = "GitHubEmptyRepositoryError";
  }
}

export class GitHubRepositoryPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubRepositoryPermissionError";
  }
}

export class GitHubConfigMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConfigMalformedError";
  }
}

export class GitHubConfigDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConfigDataError";
  }
}

export class GitHubPlaintextConfigError extends Error {
  constructor() {
    super("GitHub sync requires an encrypted repository config");
    this.name = "GitHubPlaintextConfigError";
  }
}

export class GitHubRepositoryIdentityChangedError extends Error {
  constructor() {
    super("The remote repository identity changed");
    this.name = "GitHubRepositoryIdentityChangedError";
  }
}

export class GitHubConfigNotInitializedError extends Error {
  constructor() {
    super(
      "The repository has no sync config and no encrypted candidate was provided"
    );
    this.name = "GitHubConfigNotInitializedError";
  }
}

export class GitHubConfigRaceError extends Error {
  /** The config another device published while this device was initializing. */
  constructor(readonly config: EncryptedRepositoryConfig) {
    super(
      "Another device initialized the repository with a different sync password"
    );
    this.name = "GitHubConfigRaceError";
  }
}

export interface GitHubRepositoryMeta {
  owner: string;
  repository: string;
  branch: string;
  defaultBranch: string;
  defaultBranchHead: string;
  privateRepo: boolean;
  pullPermission: boolean;
  pushPermission: boolean;
}

export interface GitHubRepositoryInspection {
  repository: GitHubRepositoryMeta;
  branchExists: boolean;
  branchHeadSha?: string;
  config?: EncryptedRepositoryConfig;
}

export interface GitHubInitializeOptions {
  candidate?: EncryptedRepositoryConfig;
  kek?: Uint8Array;
  expectedRepositoryId?: string;
  expectedFingerprint?: string;
  expectedMode?: "aes-256-gcm";
}

export interface GitHubInitializedRepository {
  branch: string;
  branchHeadSha: string;
  config: EncryptedRepositoryConfig;
  access: RepositoryAccess;
  created: boolean;
}

export interface GitHubRepositoryOptions {
  maxInitializationAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  backoffMilliseconds?: (attempt: number) => number;
}

interface GitHubRepoResponse {
  private?: boolean;
  default_branch?: string | null;
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean };
}

interface GitHubRefResponse {
  object?: { sha?: string; type?: string };
}

interface GitHubCommitResponse {
  sha?: string;
  tree?: { sha?: string };
  parents?: Array<{ sha?: string }>;
}

interface GitHubTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

interface ValidGitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface GitHubTreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: GitHubTreeEntry[];
}

interface GitHubBlobResponse {
  sha?: string;
  encoding?: string;
  content?: string;
}

interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: ValidGitHubTreeEntry[];
}

function assertCommit(sha: string, value: GitHubCommitResponse | undefined) {
  if (
    typeof value?.sha !== "string" ||
    value.sha !== sha ||
    typeof value.tree?.sha !== "string" ||
    !SHA_REGEX.test(value.tree.sha) ||
    !Array.isArray(value.parents) ||
    value.parents.some(
      (parent) => typeof parent?.sha !== "string" || !SHA_REGEX.test(parent.sha)
    )
  ) {
    throw new GitHubConfigDataError("GitHub commit response is invalid");
  }
}

/**
 * Validates a GitHub repository, reads its sync config, and initializes an
 * encrypted config on the dedicated sync branch. Private repositories only,
 * AES-GCM configs only, and the remote config is never overwritten.
 */
export class GitHubRepository {
  private readonly maxInitializationAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly backoffMilliseconds: (attempt: number) => number;

  constructor(
    private readonly client: GitHubApiClient,
    private readonly owner: string,
    private readonly repository: string,
    private readonly branch = GITHUB_SYNC_BRANCH,
    options: GitHubRepositoryOptions = {}
  ) {
    this.maxInitializationAttempts =
      options.maxInitializationAttempts ?? DEFAULT_INITIALIZATION_ATTEMPTS;
    this.sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.backoffMilliseconds =
      options.backoffMilliseconds ??
      ((attempt: number) => Math.min(2000 * 2 ** (attempt - 1), 30000));
  }

  /**
   * Validates that the repository is private, non-empty, and the token has
   * Contents read/write evidence where the API provides it. Read-only.
   */
  async validateRepository(): Promise<GitHubRepositoryMeta> {
    const result = await this.client.getJson<GitHubRepoResponse>(
      repoPath(this.owner, this.repository)
    );
    const value = result.value;
    if (!value || typeof value !== "object") {
      throw new GitHubConfigDataError("GitHub repository response is invalid");
    }
    if (value.private !== true) {
      throw new GitHubPublicRepositoryError();
    }
    const defaultBranch = value.default_branch;
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
      throw new GitHubEmptyRepositoryError();
    }
    const permissions = value.permissions;
    if (permissions && typeof permissions === "object") {
      if (permissions.pull === false) {
        throw new GitHubRepositoryPermissionError(
          "The token does not have Contents read access to the repository"
        );
      }
      if (permissions.push === false) {
        throw new GitHubRepositoryPermissionError(
          "The token does not have Contents write access to the repository"
        );
      }
    }
    const defaultBranchHead = await this.readBranchRef(defaultBranch);
    if (defaultBranchHead === undefined) {
      throw new GitHubEmptyRepositoryError();
    }
    return {
      owner: this.owner,
      repository: this.repository,
      branch: this.branch,
      defaultBranch,
      defaultBranchHead,
      privateRepo: true,
      pullPermission: permissions?.pull !== false,
      pushPermission: permissions?.push !== false,
    };
  }

  /**
   * Read-only repository inspection: validates the repository, reports whether
   * the sync branch exists, and reads a valid encrypted config when present.
   * Makes no remote writes.
   */
  async inspect(): Promise<GitHubRepositoryInspection> {
    const meta = await this.validateRepository();
    const branchHeadSha = await this.readBranchRef(this.branch);
    if (branchHeadSha === undefined) {
      return { repository: meta, branchExists: false };
    }
    return {
      repository: meta,
      branchExists: true,
      branchHeadSha,
      config: await this.readConfig(branchHeadSha),
    };
  }

  /**
   * Initializes or adopts the encrypted sync config on the dedicated branch.
   * The candidate is verified locally before any remote write. An existing
   * config is verified (never overwritten) and adopted on branch races.
   */
  async initialize(
    options: GitHubInitializeOptions
  ): Promise<GitHubInitializedRepository> {
    const meta = await this.validateRepository();

    const headSha = await this.readBranchRef(this.branch);
    const existing =
      headSha === undefined ? undefined : await this.readConfig(headSha);

    if (existing) {
      const access = await this.verifyExisting(existing, options);
      return {
        branch: this.branch,
        branchHeadSha: headSha as string,
        config: existing,
        access,
        created: false,
      };
    }

    const candidate = options.candidate;
    if (!candidate) {
      throw new GitHubConfigNotInitializedError();
    }
    if (candidate.encryption.mode !== "aes-256-gcm") {
      throw new GitHubPlaintextConfigError();
    }
    if (!options.kek) {
      throw new RepositoryPasswordError();
    }
    // Verify the candidate and sync password locally before any remote write.
    const localAccess = await verifyRepositoryAccess(candidate, options.kek);
    this.enforceExpectedIdentity(localAccess, options);

    const branchHeadSha = await this.ensureSyncBranch(meta);

    const written = await this.writeConfig(
      candidate,
      options.kek,
      branchHeadSha
    );
    return {
      branch: this.branch,
      branchHeadSha: written.headSha,
      config: written.config,
      access: written.access,
      created: !written.adopted,
    };
  }

  private enforceExpectedIdentity(
    access: RepositoryAccess,
    options: GitHubInitializeOptions
  ) {
    if (
      access.mode !== "aes-256-gcm" &&
      options.expectedMode === "aes-256-gcm"
    ) {
      throw new GitHubRepositoryIdentityChangedError();
    }
    if (
      options.expectedRepositoryId &&
      access.repositoryId !== options.expectedRepositoryId
    ) {
      throw new GitHubRepositoryIdentityChangedError();
    }
    if (
      options.expectedFingerprint &&
      access.fingerprint !== options.expectedFingerprint
    ) {
      throw new GitHubRepositoryIdentityChangedError();
    }
  }

  private async verifyExisting(
    config: EncryptedRepositoryConfig,
    options: GitHubInitializeOptions
  ) {
    if (config.encryption.mode !== "aes-256-gcm") {
      throw new GitHubPlaintextConfigError();
    }
    const access = await verifyRepositoryAccess(config, options.kek);
    this.enforceExpectedIdentity(access, options);
    return access;
  }

  private refReadSuffix(branch: string) {
    return `git/ref/${encodeBranchRef(`heads/${branch}`)}`;
  }

  private refWriteSuffix(branch: string) {
    return `git/refs/${encodeBranchRef(`heads/${branch}`)}`;
  }

  private commitPath(sha: string) {
    return repoPath(this.owner, this.repository, `git/commits/${sha}`);
  }

  private treePath(sha: string) {
    return repoPath(this.owner, this.repository, `git/trees/${sha}`);
  }

  private blobsPath() {
    return repoPath(this.owner, this.repository, "git/blobs");
  }

  private treesPath() {
    return repoPath(this.owner, this.repository, "git/trees");
  }

  private commitsPath() {
    return repoPath(this.owner, this.repository, "git/commits");
  }

  private async readBranchRef(branch: string): Promise<string | undefined> {
    let result;
    try {
      result = await this.client.getJson<GitHubRefResponse>(
        repoPath(this.owner, this.repository, this.refReadSuffix(branch)),
        { maximumBytes: MAX_META_JSON_BYTES }
      );
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 404 || error.status === 409)
      ) {
        return undefined;
      }
      throw error;
    }
    const object = result.value?.object;
    if (
      typeof object?.sha !== "string" ||
      !SHA_REGEX.test(object.sha) ||
      (typeof object.type === "string" && object.type !== "commit")
    ) {
      throw new GitHubConfigDataError("GitHub branch ref response is invalid");
    }
    return object.sha;
  }

  private async getCommit(sha: string) {
    const result = await this.client.getJson<GitHubCommitResponse>(
      this.commitPath(sha),
      { maximumBytes: MAX_META_JSON_BYTES }
    );
    assertCommit(sha, result.value);
    return {
      sha: (result.value as GitHubCommitResponse).sha as string,
      treeSha: (result.value as GitHubCommitResponse).tree?.sha as string,
      parents: ((result.value as GitHubCommitResponse).parents || []).map(
        (parent) => parent.sha as string
      ),
    };
  }

  private async getTree(sha: string, recursive: boolean): Promise<GitHubTree> {
    const result = await this.client.getJson<GitHubTreeResponse>(
      this.treePath(sha),
      {
        query: recursive ? { recursive: "1" } : undefined,
        maximumBytes: MAX_META_JSON_BYTES,
      }
    );
    const value = result.value;
    if (!value || !Array.isArray(value.tree)) {
      throw new GitHubConfigDataError("GitHub tree response is invalid");
    }
    const paths = new Set<string>();
    const tree: ValidGitHubTreeEntry[] = [];
    for (const entry of value.tree) {
      if (
        typeof entry.path !== "string" ||
        entry.path.length === 0 ||
        typeof entry.mode !== "string" ||
        typeof entry.type !== "string" ||
        typeof entry.sha !== "string" ||
        !SHA_REGEX.test(entry.sha)
      ) {
        throw new GitHubConfigDataError(
          "GitHub tree contains an invalid entry"
        );
      }
      if (paths.has(entry.path)) {
        throw new GitHubConfigDataError(
          "GitHub tree contains a duplicate path"
        );
      }
      paths.add(entry.path);
      tree.push({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha.toLowerCase(),
      });
    }
    return {
      sha:
        typeof value.sha === "string" && SHA_REGEX.test(value.sha)
          ? value.sha.toLowerCase()
          : sha.toLowerCase(),
      truncated: value.truncated === true,
      tree,
    };
  }

  private async downloadConfigBlob(sha: string): Promise<string> {
    const result = await this.client.getJson<GitHubBlobResponse>(
      repoPath(this.owner, this.repository, `git/blobs/${sha}`),
      { maximumBytes: MAX_CONFIG_BLOB_BYTES }
    );
    const blob = result.value;
    if (!blob || typeof blob.content !== "string") {
      throw new GitHubConfigDataError("GitHub config blob response is invalid");
    }
    if (
      blob.sha !== undefined &&
      blob.sha.toLowerCase() !== sha.toLowerCase()
    ) {
      throw new GitHubConfigDataError("GitHub config blob sha is invalid");
    }
    let bytes: Uint8Array;
    try {
      if (blob.encoding === "utf-8") {
        bytes = new TextEncoder().encode(blob.content);
      } else if (blob.encoding === "base64") {
        bytes = decodeGitHubBlobBase64(
          blob.content,
          "GitHub config blob content"
        );
      } else {
        throw new Error("GitHub config blob encoding is unsupported");
      }
    } catch (error) {
      throw new GitHubConfigDataError(
        error instanceof Error
          ? error.message
          : "GitHub config blob is not readable"
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONFIG_BLOB_BYTES) {
      throw new GitHubConfigDataError("GitHub config blob size is invalid");
    }
    if ((await gitBlobSha(bytes)) !== sha) {
      throw new GitHubConfigDataError(
        "GitHub config blob content does not match its sha"
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubConfigDataError("GitHub config blob is not valid UTF-8");
    }
    return text;
  }

  /**
   * Reads the exact AuthenticatorSync/config.json blob from the branch head
   * using a deterministic non-recursive walk. Missing config returns undefined;
   * malformed, duplicate, or wrong-type paths fail closed.
   */
  private async readConfig(
    headSha: string
  ): Promise<EncryptedRepositoryConfig | undefined> {
    const commit = await this.getCommit(headSha);
    return this.readConfigFromTree(commit.treeSha);
  }

  private async locateConfigBlobSha(
    root: GitHubTree
  ): Promise<string | undefined> {
    const flat = root.tree.filter((entry) => entry.path === GITHUB_CONFIG_PATH);
    if (flat.length > 1) {
      throw new GitHubConfigMalformedError(
        "AuthenticatorSync contains duplicate config paths"
      );
    }
    if (flat.length === 1) {
      if (flat[0].type !== "blob") {
        throw new GitHubConfigMalformedError("config.json is not a file");
      }
      return flat[0].sha;
    }
    const dirs = root.tree.filter(
      (entry) => entry.path === "AuthenticatorSync"
    );
    if (dirs.length === 0) {
      return undefined;
    }
    if (dirs.length > 1) {
      throw new GitHubConfigMalformedError(
        "AuthenticatorSync path is duplicated"
      );
    }
    if (dirs[0].type !== "tree") {
      throw new GitHubConfigMalformedError(
        "AuthenticatorSync is not a directory"
      );
    }
    const syncTree = await this.getTree(dirs[0].sha, false);
    if (syncTree.truncated) {
      throw new GitHubConfigMalformedError(
        "AuthenticatorSync tree is truncated"
      );
    }
    const configEntries = syncTree.tree.filter(
      (entry) => entry.path === "config.json"
    );
    if (configEntries.length > 1) {
      throw new GitHubConfigMalformedError(
        "AuthenticatorSync contains duplicate config paths"
      );
    }
    if (configEntries.length === 0) {
      if (
        syncTree.tree.some((entry) => entry.path?.startsWith("config.json/"))
      ) {
        throw new GitHubConfigMalformedError("config.json is not a file");
      }
      return undefined;
    }
    if (configEntries[0].type !== "blob") {
      throw new GitHubConfigMalformedError("config.json is not a file");
    }
    return configEntries[0].sha;
  }

  private async readConfigFromTree(
    treeSha: string
  ): Promise<EncryptedRepositoryConfig | undefined> {
    const root = await this.getTree(treeSha, false);
    if (root.truncated) {
      throw new GitHubConfigMalformedError("Root tree is truncated");
    }
    const sha = await this.locateConfigBlobSha(root);
    if (!sha) {
      return undefined;
    }
    if (!SHA_REGEX.test(sha)) {
      throw new GitHubConfigMalformedError("config blob sha is invalid");
    }
    const serialized = await this.downloadConfigBlob(sha);
    let config: ReturnType<typeof parseRepositoryConfig>;
    try {
      config = parseRepositoryConfig(serialized);
    } catch (error) {
      throw new GitHubConfigDataError(
        error instanceof Error ? error.message : "Repository config is invalid"
      );
    }
    if (config.encryption.mode !== "aes-256-gcm") {
      throw new GitHubPlaintextConfigError();
    }
    return config as EncryptedRepositoryConfig;
  }

  private async ensureSyncBranch(meta: GitHubRepositoryMeta): Promise<string> {
    const existing = await this.readBranchRef(this.branch);
    if (existing) {
      return existing;
    }
    try {
      const result = await this.client.postJson<GitHubRefResponse>(
        repoPath(this.owner, this.repository, "git/refs"),
        { ref: `refs/heads/${this.branch}`, sha: meta.defaultBranchHead }
      );
      const sha = result.value?.object?.sha;
      if (typeof sha === "string" && SHA_REGEX.test(sha)) {
        return sha;
      }
      return meta.defaultBranchHead;
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 409 || error.status === 422)
      ) {
        const fresh = await this.readBranchRef(this.branch);
        if (fresh) {
          return fresh;
        }
        throw new GitHubConfigDataError("The sync branch could not be created");
      }
      throw error;
    }
  }

  private retryableDelay(error: unknown, attempt: number) {
    const retryAfterMilliseconds =
      error instanceof GitHubHttpError && error.retryAfter !== undefined
        ? error.retryAfter * 1000
        : this.backoffMilliseconds(attempt);
    return this.sleep(retryAfterMilliseconds);
  }

  private async writeConfig(
    candidate: EncryptedRepositoryConfig,
    kek: Uint8Array,
    startHeadSha: string
  ): Promise<{
    headSha: string;
    config: EncryptedRepositoryConfig;
    access: RepositoryAccess;
    adopted: boolean;
  }> {
    let headSha = startHeadSha;
    for (
      let attempt = 1;
      attempt <= this.maxInitializationAttempts;
      attempt += 1
    ) {
      const atHead = await this.readConfig(headSha);
      if (atHead) {
        return this.adoptOrThrowRace(atHead, kek, headSha);
      }
      try {
        const written = await this.writeConfigOnce(candidate, kek, headSha);
        return {
          headSha: written.headSha,
          config: candidate,
          access: written.access,
          adopted: false,
        };
      } catch (error) {
        if (error instanceof BranchMovedError) {
          headSha = error.freshHeadSha;
          continue;
        }
        if (error instanceof BranchProtectedError) {
          throw error;
        }
        if (
          error instanceof GitHubHttpError &&
          classifyGitHubError(error).retryable &&
          attempt < this.maxInitializationAttempts
        ) {
          await this.retryableDelay(error, attempt);
          continue;
        }
        throw error;
      }
    }
    throw new CommitVerificationError(
      "Giving up after repeated failures initializing the repository config"
    );
  }

  /**
   * A config appeared at the current head after this writer had already decided
   * to initialize: the pre-write read was empty and the local candidate was
   * verified. If the supplied KEK verifies the published config, adopt it.
   * Otherwise another device won the race with a different sync password /
   * KDF salt, so report a typed race error carrying the published config
   * instead of a generic wrong-password error.
   */
  private async adoptOrThrowRace(
    atHead: EncryptedRepositoryConfig,
    kek: Uint8Array,
    headSha: string
  ): Promise<{
    headSha: string;
    config: EncryptedRepositoryConfig;
    access: RepositoryAccess;
    adopted: boolean;
  }> {
    try {
      const access = await verifyRepositoryAccess(atHead, kek);
      return { headSha, config: atHead, access, adopted: true };
    } catch (error) {
      if (error instanceof RepositoryPasswordError) {
        throw new GitHubConfigRaceError(atHead);
      }
      throw error;
    }
  }

  private async writeConfigOnce(
    candidate: EncryptedRepositoryConfig,
    kek: Uint8Array,
    headSha: string
  ): Promise<{ headSha: string; access: RepositoryAccess }> {
    const commit = await this.getCommit(headSha);
    const baseTreeSha = commit.treeSha;
    const serialized = serializeRepositoryConfig(candidate);
    const bytes = new TextEncoder().encode(serialized);
    const expectedSha = await gitBlobSha(bytes);

    const blobResult = await this.client.postJson<GitHubBlobResponse>(
      this.blobsPath(),
      { content: encodeBase64(bytes), encoding: "base64" }
    );
    const blobSha = blobResult.value?.sha;
    if (typeof blobSha !== "string" || blobSha !== expectedSha) {
      throw new CommitVerificationError(
        "GitHub config blob sha does not match the sent bytes"
      );
    }

    const treeResult = await this.client.postJson<GitHubTreeResponse>(
      this.treesPath(),
      {
        base_tree: baseTreeSha,
        tree: [
          {
            path: GITHUB_CONFIG_PATH,
            mode: "100644",
            type: "blob",
            sha: blobSha,
          },
        ],
      }
    );
    const newTreeSha = treeResult.value?.sha;
    if (typeof newTreeSha !== "string" || !SHA_REGEX.test(newTreeSha)) {
      throw new CommitVerificationError("GitHub tree response is invalid");
    }

    const commitResult = await this.client.postJson<GitHubCommitResponse>(
      this.commitsPath(),
      {
        message: INITIALIZATION_COMMIT_MESSAGE,
        tree: newTreeSha,
        parents: [headSha],
      }
    );
    const newCommitSha = commitResult.value?.sha;
    if (typeof newCommitSha !== "string" || !SHA_REGEX.test(newCommitSha)) {
      throw new CommitVerificationError("GitHub commit response is invalid");
    }

    try {
      await this.client.patchJson<GitHubRefResponse>(
        repoPath(this.owner, this.repository, this.refWriteSuffix(this.branch)),
        { sha: newCommitSha, force: false }
      );
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 409 || error.status === 422)
      ) {
        const freshHead = await this.readBranchRef(this.branch);
        if (freshHead === undefined) {
          throw new CommitVerificationError(
            "The sync branch disappeared during initialization"
          );
        }
        if (isBranchProtectionRejection(error)) {
          throw new BranchProtectedError(
            "GitHub ref update was rejected by branch rules"
          );
        }
        // Retry transient 409/422 responses even if a competing ref update is
        // not visible yet; GitHub also uses 422 for temporary ref-lock races.
        throw new BranchMovedError(freshHead);
      }
      if (error instanceof TypeError) {
        // The response was lost; confirm the update actually landed before
        // continuing to the common verification path.
        const freshHead = await this.readBranchRef(this.branch);
        if (freshHead === undefined) {
          throw new CommitVerificationError(
            "The sync branch could not be re-read after a lost response"
          );
        }
        if (freshHead !== newCommitSha) {
          throw new BranchMovedError(freshHead);
        }
      } else {
        throw error;
      }
    }

    // The update is acknowledged or confirmed to have landed. Verify it on the
    // CURRENT branch, not a possibly-dangling commit.
    await this.assertCurrentHeadIs(newCommitSha);
    const access = await this.verifyCommittedConfig(
      bytes,
      newCommitSha,
      expectedSha,
      kek
    );
    // Final fence: the branch must still point at our commit after verification.
    await this.assertCurrentHeadIs(newCommitSha);
    return { headSha: newCommitSha, access };
  }

  /**
   * Re-reads the current branch ref and requires it to equal the commit we just
   * created. Any other head is reported as a branch move so the caller can
   * re-read and adopt a winning config or retry against the fresh head.
   */
  private async assertCurrentHeadIs(expectedHeadSha: string): Promise<void> {
    const currentHead = await this.readBranchRef(this.branch);
    if (currentHead === undefined) {
      throw new CommitVerificationError(
        "The sync branch disappeared during verification"
      );
    }
    if (currentHead !== expectedHeadSha) {
      throw new BranchMovedError(currentHead);
    }
  }

  private async verifyCommittedConfig(
    expectedBytes: Uint8Array,
    commitSha: string,
    expectedSha: string,
    kek: Uint8Array
  ) {
    const commit = await this.getCommit(commitSha);
    const root = await this.getTree(commit.treeSha, false);
    if (root.truncated) {
      throw new CommitVerificationError(
        "The committed tree could not be verified"
      );
    }
    const configSha = await this.locateConfigBlobSha(root);
    if (!configSha || configSha !== expectedSha.toLowerCase()) {
      throw new CommitVerificationError(
        "The committed config does not match the uploaded bytes"
      );
    }
    const serialized = await this.downloadConfigBlob(expectedSha);
    if (serialized !== new TextDecoder().decode(expectedBytes)) {
      throw new CommitVerificationError(
        "The committed config content differs from the upload"
      );
    }
    let config;
    try {
      config = parseRepositoryConfig(serialized);
    } catch (error) {
      throw new CommitVerificationError(
        error instanceof Error
          ? error.message
          : "The committed config is invalid"
      );
    }
    if (config.encryption.mode !== "aes-256-gcm") {
      throw new GitHubPlaintextConfigError();
    }
    return verifyRepositoryAccess(config as EncryptedRepositoryConfig, kek);
  }
}
