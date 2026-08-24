import {
  encodeBranchRef,
  GitHubApiClient,
  GitHubHttpError,
  GitHubResponseTooLargeError,
  repoPath,
} from "./GitHubApiClient";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DEVICE_DIRECTORIES = 1000;
const MAX_OPERATION_FILES = 100000;
const OPS_PREFIX = "AuthenticatorSync/ops/";
const MAX_META_JSON_BYTES = 1024 * 1024;

export interface GitHubOperationFile {
  deviceId: string;
  opId: string;
  sha: string;
}

export interface GitHubBranchHead {
  sha: string;
  etag?: string;
  notModified: boolean;
}

export interface GitHubCommitInfo {
  sha: string;
  treeSha: string;
  parents: string[];
}

interface GitHubRefResponse {
  ref?: string;
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

interface GitHubTreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: GitHubTreeEntry[];
}

interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

export class GitHubOperationListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOperationListingError";
  }
}

function assertUuid(value: unknown, name: string) {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new GitHubOperationListingError(`${name} must be a lowercase UUIDv4`);
  }
}

function assertBlobSha(sha: unknown) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitHubOperationListingError("GitHub blob sha is invalid");
  }
}

export class GitHubTreeReader {
  constructor(
    private readonly client: GitHubApiClient,
    private readonly owner: string,
    private readonly repository: string,
    private readonly branch: string
  ) {}

  private refSuffix() {
    return `git/ref/${encodeBranchRef(`heads/${this.branch}`)}`;
  }

  private commitPath(sha: string) {
    return repoPath(this.owner, this.repository, `git/commits/${sha}`);
  }

  private treePath(sha: string) {
    return repoPath(this.owner, this.repository, `git/trees/${sha}`);
  }

  /**
   * Reads the branch ref. A 304 conditional response is accepted only when a
   * cached head sha is supplied; the returned sha in that case is the cached
   * value.
   */
  async getBranchHead(
    options: { etag?: string; cachedSha?: string } = {}
  ): Promise<GitHubBranchHead> {
    let result;
    try {
      result = await this.client.getJson<GitHubRefResponse>(
        repoPath(this.owner, this.repository, this.refSuffix()),
        { etag: options.etag }
      );
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 404 || error.status === 409)
      ) {
        throw new GitHubOperationListingError(
          `GitHub branch ${this.branch} does not exist`
        );
      }
      throw error;
    }
    if (result.notModified) {
      if (typeof options.cachedSha !== "string") {
        throw new GitHubOperationListingError(
          "Not-modified branch response requires a cached head sha"
        );
      }
      return {
        sha: options.cachedSha,
        etag: result.etag ?? options.etag,
        notModified: true,
      };
    }
    const object = result.value?.object;
    if (
      typeof object?.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(object.sha) ||
      (typeof object.type === "string" && object.type !== "commit")
    ) {
      throw new GitHubOperationListingError(
        "GitHub branch ref response is invalid"
      );
    }
    return {
      sha: object.sha,
      etag: result.etag,
      notModified: false,
    };
  }

  async getCommit(sha: string): Promise<GitHubCommitInfo> {
    const result = await this.client.getJson<GitHubCommitResponse>(
      this.commitPath(sha)
    );
    const value = result.value;
    if (
      typeof value?.sha !== "string" ||
      value.sha !== sha ||
      typeof value.tree?.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(value.tree.sha) ||
      !Array.isArray(value.parents) ||
      value.parents.some(
        (parent) =>
          typeof parent?.sha !== "string" || !/^[0-9a-f]{40}$/.test(parent.sha)
      )
    ) {
      throw new GitHubOperationListingError(
        "GitHub commit response is invalid"
      );
    }
    return {
      sha: value.sha,
      treeSha: value.tree.sha,
      parents: value.parents.map((parent) => parent.sha as string),
    };
  }

  private async getTree(sha: string, recursive: boolean): Promise<GitHubTree> {
    const result = await this.client.getJson<GitHubTreeResponse>(
      this.treePath(sha),
      {
        query: recursive ? { recursive: "1" } : undefined,
        // Recursive listings may legitimately exceed one MiB before GitHub
        // marks them truncated (the documented limit is about 100k entries or
        // 7 MB), so only the non-recursive subtree reads keep the small cap.
        maximumBytes: recursive ? undefined : MAX_META_JSON_BYTES,
      }
    );
    const value = result.value;
    if (!value || !Array.isArray(value.tree)) {
      throw new GitHubOperationListingError("GitHub tree response is invalid");
    }
    const paths = new Set<string>();
    for (const entry of value.tree) {
      if (
        typeof entry.path !== "string" ||
        entry.path.length === 0 ||
        typeof entry.mode !== "string" ||
        typeof entry.type !== "string" ||
        typeof entry.sha !== "string" ||
        !/^[0-9a-f]{40}$/.test(entry.sha)
      ) {
        throw new GitHubOperationListingError(
          "GitHub tree contains an invalid entry"
        );
      }
      if (paths.has(entry.path)) {
        throw new GitHubOperationListingError(
          "GitHub tree contains a duplicate path"
        );
      }
      paths.add(entry.path);
    }
    return {
      sha:
        typeof value.sha === "string" && /^[0-9a-fA-F]{40}$/.test(value.sha)
          ? value.sha.toLowerCase()
          : sha.toLowerCase(),
      truncated: value.truncated === true,
      tree: value.tree,
    };
  }

  private assertNotTruncated(tree: GitHubTree) {
    if (tree.truncated) {
      throw new GitHubOperationListingError("GitHub tree listing is truncated");
    }
  }

  /**
   * Enumerates only AuthenticatorSync/ops/<device UUID>/<op UUID>.json files.
   * Uses the recursive tree API and falls back to a complete non-recursive
   * subtree walk when the recursive response is truncated or exceeds the
   * response size limit. Never reads blob content during listing.
   */
  async listOperationFiles(headSha: string): Promise<GitHubOperationFile[]> {
    const commit = await this.getCommit(headSha);
    return this.listOperationFilesFromTree(commit.treeSha);
  }

  /**
   * Enumerates operations from an already-known tree without re-reading the
   * commit. Falls back to the non-recursive subtree walk when the recursive
   * response is truncated or too large to transfer.
   */
  async listOperationFilesFromTree(
    treeSha: string
  ): Promise<GitHubOperationFile[]> {
    try {
      const root = await this.getTree(treeSha, true);
      if (root.truncated) {
        return this.collectNonRecursive(treeSha);
      }
      return this.collectRecursive(root.tree);
    } catch (error) {
      if (error instanceof GitHubResponseTooLargeError) {
        return this.collectNonRecursive(treeSha);
      }
      throw error;
    }
  }

  private collectRecursive(entries: GitHubTreeEntry[]): GitHubOperationFile[] {
    const files: GitHubOperationFile[] = [];
    const seenDevices = new Map<string, string>();
    for (const entry of entries) {
      const path = entry.path as string;
      if (!path.startsWith("AuthenticatorSync/")) {
        continue;
      }
      const relative = path.slice("AuthenticatorSync/".length);
      if (entry.type === "tree") {
        if (relative === "") {
          continue;
        }
        const parts = relative.split("/");
        if (parts.length === 1 && parts[0] === "ops") {
          continue;
        }
        if (parts.length === 2 && parts[0] === "ops") {
          assertUuid(parts[1], "Remote device id");
          continue;
        }
        throw new GitHubOperationListingError(
          `GitHub tree contains an invalid nested directory: ${path}`
        );
      }
      if (entry.type !== "blob") {
        throw new GitHubOperationListingError(
          `GitHub tree contains an unsupported entry: ${path}`
        );
      }
      if (relative === "config.json") {
        continue;
      }
      const parts = relative.split("/");
      if (parts[0] !== "ops") {
        // Ignore README/.gitkeep/other non-sync files beside config.json.
        continue;
      }
      if (parts.length !== 3) {
        throw new GitHubOperationListingError(
          `GitHub tree contains an invalid resource: ${path}`
        );
      }
      const deviceId = parts[1];
      assertUuid(deviceId, "Remote device id");
      const opId = this.parseOperationFileName(parts[2], path);
      this.recordOperation(files, seenDevices, deviceId, opId, entry.sha);
    }
    return files;
  }

  private async collectNonRecursive(
    treeSha: string
  ): Promise<GitHubOperationFile[]> {
    const root = await this.getTree(treeSha, false);
    this.assertNotTruncated(root);
    const authenticatorSyncEntries = root.tree.filter(
      (entry) => entry.path === "AuthenticatorSync"
    );
    if (authenticatorSyncEntries.length === 0) {
      return [];
    }
    const authenticatorSync = authenticatorSyncEntries[0];
    if (authenticatorSync.type !== "tree") {
      throw new GitHubOperationListingError(
        "AuthenticatorSync must be a directory"
      );
    }
    const syncTree = await this.getTree(authenticatorSync.sha as string, false);
    this.assertNotTruncated(syncTree);
    let opsTreeEntry: GitHubTreeEntry | undefined;
    for (const entry of syncTree.tree) {
      if (entry.path === "ops") {
        if (entry.type !== "tree") {
          throw new GitHubOperationListingError(
            "AuthenticatorSync/ops must be a directory"
          );
        }
        opsTreeEntry = entry;
      } else if (entry.path === "config.json") {
        if (entry.type !== "blob") {
          throw new GitHubOperationListingError(
            "AuthenticatorSync/config.json must be a file"
          );
        }
      }
    }
    if (!opsTreeEntry) {
      return [];
    }
    const opsTree = await this.getTree(opsTreeEntry.sha as string, false);
    this.assertNotTruncated(opsTree);
    const deviceEntries = opsTree.tree.filter((entry) => entry.type === "tree");
    if (deviceEntries.length > MAX_DEVICE_DIRECTORIES) {
      throw new GitHubOperationListingError(
        "GitHub repository contains too many device directories"
      );
    }
    for (const entry of opsTree.tree) {
      if (entry.type !== "tree") {
        throw new GitHubOperationListingError(
          "GitHub ops directory contains a non-directory resource"
        );
      }
    }
    const files: GitHubOperationFile[] = [];
    const seenDevices = new Map<string, string>();
    for (const deviceEntry of deviceEntries) {
      const deviceId = deviceEntry.path as string;
      assertUuid(deviceId, "Remote device id");
      const deviceTree = await this.getTree(deviceEntry.sha as string, false);
      this.assertNotTruncated(deviceTree);
      for (const fileEntry of deviceTree.tree) {
        if (fileEntry.type !== "blob") {
          throw new GitHubOperationListingError(
            "GitHub device directory contains a nested resource"
          );
        }
        const opId = this.parseOperationFileName(
          fileEntry.path as string,
          `${OPS_PREFIX}${deviceId}/${fileEntry.path}`
        );
        this.recordOperation(files, seenDevices, deviceId, opId, fileEntry.sha);
      }
    }
    return files;
  }

  private parseOperationFileName(fileName: string, fullPath: string) {
    const match = fileName.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/
    );
    if (!match) {
      throw new GitHubOperationListingError(
        `GitHub tree contains an invalid operation file: ${fullPath}`
      );
    }
    return match[1];
  }

  private recordOperation(
    files: GitHubOperationFile[],
    seenDevices: Map<string, string>,
    deviceId: string,
    opId: string,
    sha: string | undefined
  ) {
    assertBlobSha(sha);
    const existingDevice = seenDevices.get(opId);
    if (existingDevice && existingDevice !== deviceId) {
      throw new GitHubOperationListingError(
        `Remote operation appears under multiple devices: ${opId}`
      );
    }
    seenDevices.set(opId, deviceId);
    files.push({ deviceId, opId, sha: sha as string });
    if (files.length > MAX_OPERATION_FILES) {
      throw new GitHubOperationListingError(
        "GitHub repository contains too many operation files"
      );
    }
  }
}
