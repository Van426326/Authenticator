import {
  encodeBranchRef,
  GitHubApiClient,
  GitHubHttpError,
  repoPath,
} from "./GitHubApiClient";
import { encodeBase64 } from "../Base64";
import { gitBlobSha } from "./GitBlobSha";
import { GitHubTreeReader } from "./GitHubTreeReader";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_MAX_OPERATIONS = 50;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

export interface ImmutableOperationFile {
  deviceId: string;
  opId: string;
  /** Exact durable envelope bytes; replayed verbatim, never regenerated. */
  bytes: Uint8Array;
}

export interface LegacyOperationPathRepair {
  opId: string;
  fromDeviceId: string;
  toDeviceId: string;
  /** Exact Git blob SHA already verified against the encrypted envelope. */
  sha: string;
}

export class GitHubBranchMissingError extends Error {
  constructor(readonly branch: string) {
    super(`GitHub branch ${branch} does not exist`);
    this.name = "GitHubBranchMissingError";
  }
}

export class BranchMovedError extends Error {
  constructor(readonly freshHeadSha: string) {
    super("GitHub branch head moved during atomic commit");
    this.name = "BranchMovedError";
  }
}

export class BranchProtectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchProtectedError";
  }
}

/** GitHub uses 422 for both branch rules and transient ref-update races. */
export function isBranchProtectionRejection(error: GitHubHttpError): boolean {
  const message = error.githubMessage?.toLowerCase() ?? "";
  return (
    message.includes("protected branch") ||
    message.includes("repository rule") ||
    message.includes("ruleset") ||
    message.includes("changes must be made through a pull request")
  );
}

export class CommitVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitVerificationError";
  }
}

export class InvalidBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBatchError";
  }
}

export class ImmutablePathConflictError extends Error {
  constructor(path: string) {
    super(`Remote operation already exists with different content: ${path}`);
    this.name = "ImmutablePathConflictError";
  }
}

interface GitHubRefResponse {
  object?: { sha?: string; type?: string };
}

interface GitHubBlobResponse {
  sha?: string;
}

interface GitHubTreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: Array<{ path?: string; type?: string; sha?: string }>;
}

interface GitHubCommitResponse {
  sha?: string;
}

export class GitHubCommitWriter {
  private readonly maxOperations: number;
  private readonly maxBatchBytes: number;
  private readonly treeReader: GitHubTreeReader;

  constructor(
    private readonly client: GitHubApiClient,
    private readonly owner: string,
    private readonly repository: string,
    private readonly branch: string,
    options: { maxOperations?: number; maxBatchBytes?: number } = {}
  ) {
    this.maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.treeReader = new GitHubTreeReader(client, owner, repository, branch);
  }

  private refSuffix() {
    return `git/refs/${encodeBranchRef(`heads/${this.branch}`)}`;
  }

  private readRefSuffix() {
    return `git/ref/${encodeBranchRef(`heads/${this.branch}`)}`;
  }

  private refPath() {
    return repoPath(this.owner, this.repository, this.refSuffix());
  }

  private readRefPath() {
    return repoPath(this.owner, this.repository, this.readRefSuffix());
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

  private opPath(file: ImmutableOperationFile) {
    return `AuthenticatorSync/ops/${file.deviceId}/${file.opId}.json`;
  }

  private opPathFromParts(deviceId: string, opId: string) {
    return `AuthenticatorSync/ops/${deviceId}/${opId}.json`;
  }

  private validateBatch(batch: ImmutableOperationFile[]) {
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new InvalidBatchError("GitHub commit batch is empty");
    }
    if (batch.length > this.maxOperations) {
      throw new InvalidBatchError(
        `GitHub commit batch exceeds ${this.maxOperations} operations`
      );
    }
    const keys = new Set<string>();
    let totalBytes = 0;
    for (const file of batch) {
      if (
        typeof file.deviceId !== "string" ||
        !UUID_V4.test(file.deviceId) ||
        typeof file.opId !== "string" ||
        !UUID_V4.test(file.opId) ||
        !(file.bytes instanceof Uint8Array) ||
        file.bytes.byteLength === 0
      ) {
        throw new InvalidBatchError(
          "GitHub commit batch contains an invalid operation"
        );
      }
      const key = `${file.deviceId}:${file.opId}`;
      if (keys.has(key)) {
        throw new InvalidBatchError(
          "GitHub commit batch contains a duplicate operation path"
        );
      }
      keys.add(key);
      totalBytes += file.bytes.byteLength;
      if (totalBytes > this.maxBatchBytes) {
        throw new InvalidBatchError(
          "GitHub commit batch exceeds the total byte limit"
        );
      }
    }
  }

  private async readBranchRef(): Promise<string> {
    let result;
    try {
      result = await this.client.getJson<GitHubRefResponse>(this.readRefPath());
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 404 || error.status === 409)
      ) {
        throw new GitHubBranchMissingError(this.branch);
      }
      throw error;
    }
    const object = result.value?.object;
    if (
      typeof object?.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(object.sha) ||
      (typeof object.type === "string" && object.type !== "commit")
    ) {
      throw new CommitVerificationError(
        "GitHub branch ref response is invalid"
      );
    }
    return object.sha;
  }

  private commitMessage(batch: ImmutableOperationFile[]) {
    const deviceIds = Array.from(new Set(batch.map((file) => file.deviceId)));
    const device = deviceIds.length === 1 ? deviceIds[0].slice(0, 8) : "multi";
    return `Authenticator sync: ${batch.length} operation(s) from ${device}`;
  }

  /**
   * Verifies that every operation in the batch is present with its exact blob
   * SHA in the tree of the current branch head. This is intentionally
   * presence-based rather than head-exact: if another device fast-forwarded the
   * branch after our commit, the operations must still be present in the
   * descendant tree for the write to count as confirmed.
   */
  private async verifyCommitted(
    batch: ImmutableOperationFile[],
    blobShas: Map<string, string>,
    currentHeadSha: string
  ) {
    const commit = await this.treeReader.getCommit(currentHeadSha);
    const files = await this.treeReader.listOperationFilesFromTree(
      commit.treeSha
    );
    const present = new Map(
      files.map((file) => [
        this.opPathFromParts(file.deviceId, file.opId),
        file.sha,
      ])
    );
    for (const file of batch) {
      const path = this.opPath(file);
      const expectedSha = blobShas.get(path);
      const actualSha = present.get(path);
      if (expectedSha === undefined || actualSha !== expectedSha) {
        throw new CommitVerificationError(
          `GitHub committed tree is missing operation ${file.opId}`
        );
      }
    }
  }

  /**
   * Appends one atomic batch of immutable operations to the sync branch.
   * Serializes blobs, builds a tree on the current head's base tree, commits
   * it, and updates the ref with force:false. The branch is re-read after the
   * ref update and every operation path/blob pair must be present on the
   * current branch head before the head SHA is returned. Never force-pushes
   * or rewrites history; an operation path that already exists with different
   * bytes is rejected before any write.
   */
  async appendOperations(batch: ImmutableOperationFile[]): Promise<string> {
    this.validateBatch(batch);

    const headSha = await this.readBranchRef();
    const headCommit = await this.treeReader.getCommit(headSha);
    const baseTreeSha = headCommit.treeSha;

    const existingFiles = await this.treeReader.listOperationFilesFromTree(
      baseTreeSha
    );
    const existingByPath = new Map(
      existingFiles.map((file) => [
        this.opPathFromParts(file.deviceId, file.opId),
        file.sha,
      ])
    );

    const blobShas = new Map<string, string>();
    const toWrite: ImmutableOperationFile[] = [];
    for (const file of batch) {
      const path = this.opPath(file);
      const expected = await gitBlobSha(file.bytes);
      blobShas.set(path, expected);
      const existingSha = existingByPath.get(path);
      if (existingSha !== undefined) {
        if (existingSha !== expected) {
          throw new ImmutablePathConflictError(path);
        }
        // Already present with identical bytes: idempotent skip.
        continue;
      }
      toWrite.push(file);
    }
    if (toWrite.length === 0) {
      return headSha;
    }

    for (const file of toWrite) {
      const path = this.opPath(file);
      const blob = await this.client.postJson<GitHubBlobResponse>(
        this.blobsPath(),
        {
          content: encodeBase64(file.bytes),
          encoding: "base64",
        }
      );
      const sha = blob.value?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new CommitVerificationError("GitHub blob response is invalid");
      }
      if (sha !== blobShas.get(path)) {
        throw new CommitVerificationError(
          `GitHub blob sha does not match the sent bytes: ${path}`
        );
      }
    }

    const treeResult = await this.client.postJson<GitHubTreeResponse>(
      this.treesPath(),
      {
        base_tree: baseTreeSha,
        tree: toWrite.map((file) => ({
          path: this.opPath(file),
          mode: "100644",
          type: "blob",
          sha: blobShas.get(this.opPath(file)),
        })),
      }
    );
    const newTreeSha = treeResult.value?.sha;
    if (typeof newTreeSha !== "string" || !/^[0-9a-f]{40}$/.test(newTreeSha)) {
      throw new CommitVerificationError("GitHub tree response is invalid");
    }

    const commitResult = await this.client.postJson<GitHubCommitResponse>(
      this.commitsPath(),
      {
        message: this.commitMessage(toWrite),
        tree: newTreeSha,
        parents: [headSha],
      }
    );
    const newCommitSha = commitResult.value?.sha;
    if (
      typeof newCommitSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(newCommitSha)
    ) {
      throw new CommitVerificationError("GitHub commit response is invalid");
    }

    try {
      await this.client.patchJson<{ sha?: string }>(this.refPath(), {
        sha: newCommitSha,
        force: false,
      });
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 409 || error.status === 422)
      ) {
        const freshHead = await this.readBranchRef();
        if (isBranchProtectionRejection(error)) {
          throw new BranchProtectedError(
            "GitHub ref update was rejected by branch rules"
          );
        }
        // 409/422 is also used for transient ref-lock and non-fast-forward
        // races. Retry even when the competing head is not visible yet.
        throw new BranchMovedError(freshHead);
      }
      if (!(error instanceof TypeError)) {
        throw error;
      }
      // The ref update may have landed even though the response was lost;
      // fall through to presence verification against the current head.
    }

    const currentHead = await this.readBranchRef();
    await this.verifyCommitted(toWrite, blobShas, currentHead);
    return currentHead;
  }

  /**
   * Explicitly repairs operations written by a legacy client under the wrong
   * device directory. Exact bytes are retained at the authenticated path and
   * under an ignored archive root; the bad live path is removed in the same
   * non-force commit. The previous commit remains an ancestor.
   */
  async repairLegacyOperationPaths(
    repairs: LegacyOperationPathRepair[]
  ): Promise<string> {
    if (repairs.length === 0 || repairs.length > DEFAULT_MAX_OPERATIONS) {
      throw new InvalidBatchError("Legacy path repair batch size is invalid");
    }
    const seenOps = new Set<string>();
    for (const repair of repairs) {
      if (
        !UUID_V4.test(repair.opId) ||
        !UUID_V4.test(repair.fromDeviceId) ||
        !UUID_V4.test(repair.toDeviceId) ||
        repair.fromDeviceId === repair.toDeviceId ||
        !/^[0-9a-f]{40}$/.test(repair.sha) ||
        seenOps.has(repair.opId)
      ) {
        throw new InvalidBatchError("Legacy path repair entry is invalid");
      }
      seenOps.add(repair.opId);
    }

    const headSha = await this.readBranchRef();
    const headCommit = await this.treeReader.getCommit(headSha);
    const baseTreeSha = headCommit.treeSha;
    const treeResult = await this.client.getJson<GitHubTreeResponse>(
      `${this.treesPath()}/${baseTreeSha}`,
      { query: { recursive: "1" } }
    );
    if (
      treeResult.value?.sha !== baseTreeSha ||
      treeResult.value.truncated !== false ||
      !Array.isArray(treeResult.value.tree)
    ) {
      throw new CommitVerificationError("GitHub repair tree is invalid");
    }
    const entries = new Map<string, string>();
    for (const entry of treeResult.value.tree) {
      if (
        typeof entry.path !== "string" ||
        entry.type !== "blob" ||
        typeof entry.sha !== "string" ||
        !/^[0-9a-f]{40}$/.test(entry.sha)
      ) {
        continue;
      }
      if (entries.has(entry.path)) {
        throw new CommitVerificationError(
          "GitHub repair tree contains duplicate paths"
        );
      }
      entries.set(entry.path, entry.sha);
    }

    const changes: Array<Record<string, unknown>> = [];
    for (const repair of repairs) {
      const source = this.opPathFromParts(repair.fromDeviceId, repair.opId);
      const target = this.opPathFromParts(repair.toDeviceId, repair.opId);
      const archive = `AuthenticatorSyncLegacy/ops/${repair.fromDeviceId}/${repair.opId}.json`;
      const sourceSha = entries.get(source);
      const targetSha = entries.get(target);
      const archiveSha = entries.get(archive);
      if (targetSha !== undefined && targetSha !== repair.sha) {
        throw new ImmutablePathConflictError(target);
      }
      if (archiveSha !== undefined && archiveSha !== repair.sha) {
        throw new ImmutablePathConflictError(archive);
      }
      if (sourceSha === undefined) {
        if (targetSha === repair.sha && archiveSha === repair.sha) {
          continue;
        }
        throw new CommitVerificationError(
          "Legacy operation source path is missing"
        );
      }
      if (sourceSha !== repair.sha) {
        throw new ImmutablePathConflictError(source);
      }
      if (targetSha === undefined) {
        changes.push({
          path: target,
          mode: "100644",
          type: "blob",
          sha: repair.sha,
        });
      }
      if (archiveSha === undefined) {
        changes.push({
          path: archive,
          mode: "100644",
          type: "blob",
          sha: repair.sha,
        });
      }
      // GitHub's Create a tree API uses a path plus sha:null as the
      // deletion form. Supplying blob mode/type on a deletion is rejected by
      // the real API with HTTP 422 ("Invalid tree info").
      changes.push({ path: source, sha: null });
    }
    if (changes.length === 0) {
      return headSha;
    }

    const nextTree = await this.client.postJson<GitHubTreeResponse>(
      this.treesPath(),
      { base_tree: baseTreeSha, tree: changes }
    );
    const newTreeSha = nextTree.value?.sha;
    if (typeof newTreeSha !== "string" || !/^[0-9a-f]{40}$/.test(newTreeSha)) {
      throw new CommitVerificationError(
        "GitHub repair tree response is invalid"
      );
    }
    const commit = await this.client.postJson<GitHubCommitResponse>(
      this.commitsPath(),
      {
        message: `Authenticator sync: repair ${repairs.length} legacy operation path(s)`,
        tree: newTreeSha,
        parents: [headSha],
      }
    );
    const newCommitSha = commit.value?.sha;
    if (
      typeof newCommitSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(newCommitSha)
    ) {
      throw new CommitVerificationError(
        "GitHub repair commit response is invalid"
      );
    }
    try {
      await this.client.patchJson<{ sha?: string }>(this.refPath(), {
        sha: newCommitSha,
        force: false,
      });
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        (error.status === 409 || error.status === 422)
      ) {
        const freshHead = await this.readBranchRef();
        if (isBranchProtectionRejection(error)) {
          throw new BranchProtectedError(
            "GitHub ref update was rejected by branch rules"
          );
        }
        throw new BranchMovedError(freshHead);
      }
      if (!(error instanceof TypeError)) {
        throw error;
      }
    }

    const currentHead = await this.readBranchRef();
    const currentCommit = await this.treeReader.getCommit(currentHead);
    const currentFiles = await this.treeReader.listOperationFilesFromTree(
      currentCommit.treeSha
    );
    const currentByPath = new Map(
      currentFiles.map((file) => [
        this.opPathFromParts(file.deviceId, file.opId),
        file.sha,
      ])
    );
    for (const repair of repairs) {
      const source = this.opPathFromParts(repair.fromDeviceId, repair.opId);
      const target = this.opPathFromParts(repair.toDeviceId, repair.opId);
      if (
        currentByPath.has(source) ||
        currentByPath.get(target) !== repair.sha
      ) {
        throw new CommitVerificationError(
          "Legacy operation path repair could not be verified"
        );
      }
    }
    return currentHead;
  }
}
