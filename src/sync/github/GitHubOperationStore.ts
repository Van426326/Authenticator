import {
  classifyGitHubError,
  GitHubApiClient,
  GitHubHttpError,
  repoPath,
} from "./GitHubApiClient";
import { gitBlobSha } from "./GitBlobSha";
import { GitHubTreeReader, GitHubOperationFile } from "./GitHubTreeReader";
import {
  BranchMovedError,
  CommitVerificationError,
  GitHubCommitWriter,
  ImmutableOperationFile,
  InvalidBatchError,
} from "./GitHubCommitWriter";
import { decodeGitHubBlobBase64 } from "./GitHubBase64";
import { FlushReceipt, RemoteOperationFile } from "../SyncEngineTypes";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_BLOB_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FLUSH_ATTEMPTS = 5;
const DEFAULT_MAX_OPERATIONS_PER_BATCH = 50;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

export class RemoteOperationRewrittenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteOperationRewrittenError";
  }
}

export class GitHubBlobDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubBlobDecodeError";
  }
}

interface PendingOperation {
  deviceId: string;
  opId: string;
  bytes: Uint8Array;
  sha: string;
}

interface GitHubBlobResponse {
  sha?: string;
  encoding?: string;
  content?: string;
  size?: number;
}

export interface GitHubOperationStoreOptions {
  maxOperationsPerBatch?: number;
  maxBatchBytes?: number;
  maxFlushAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  backoffMilliseconds?: (attempt: number) => number;
}

function assertUuid(value: string, name: string) {
  if (!UUID_V4.test(value)) {
    throw new Error(`${name} must be a lowercase UUIDv4`);
  }
}

function toBytes(envelope: string | Uint8Array) {
  if (typeof envelope === "string") {
    return new TextEncoder().encode(envelope);
  }
  if (envelope instanceof Uint8Array) {
    return envelope;
  }
  throw new Error("Operation envelope must be a string or Uint8Array");
}

export class GitHubOperationStore {
  private readonly treeReader: GitHubTreeReader;
  private readonly writer: GitHubCommitWriter;
  private readonly pending: Map<string, PendingOperation> = new Map();
  private readonly confirmed: Map<string, string> = new Map();
  private readonly maxOperationsPerBatch: number;
  private readonly maxBatchBytes: number;
  private readonly maxFlushAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly backoffMilliseconds: (attempt: number) => number;

  constructor(
    private readonly client: GitHubApiClient,
    private readonly owner: string,
    private readonly repository: string,
    private readonly branch: string,
    options: GitHubOperationStoreOptions = {}
  ) {
    this.treeReader = new GitHubTreeReader(client, owner, repository, branch);
    this.maxOperationsPerBatch =
      options.maxOperationsPerBatch ?? DEFAULT_MAX_OPERATIONS_PER_BATCH;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.writer = new GitHubCommitWriter(client, owner, repository, branch, {
      maxOperations: this.maxOperationsPerBatch,
      maxBatchBytes: this.maxBatchBytes,
    });
    this.maxFlushAttempts =
      options.maxFlushAttempts ?? DEFAULT_MAX_FLUSH_ATTEMPTS;
    this.sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.backoffMilliseconds =
      options.backoffMilliseconds ??
      ((attempt: number) => Math.min(2000 * 2 ** (attempt - 1), 30000));
  }

  private key(deviceId: string, opId: string) {
    return `${deviceId}:${opId}`;
  }

  /**
   * Buffers an operation for the next atomic commit. Exact bytes are kept and
   * replayed verbatim. An operation already confirmed on the remote returns
   * "exists" without re-uploading; a buffered duplicate returns "created".
   */
  async upload(
    deviceId: string,
    opId: string,
    envelope: string | Uint8Array
  ): Promise<"created" | "exists"> {
    assertUuid(deviceId, "Device id");
    assertUuid(opId, "Operation id");
    const bytes = toBytes(envelope);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
      throw new Error("Operation envelope size is invalid");
    }
    const key = this.key(deviceId, opId);
    const sha = await gitBlobSha(bytes);
    const confirmedSha = this.confirmed.get(key);
    if (confirmedSha !== undefined) {
      if (confirmedSha === sha) {
        return "exists";
      }
      throw new Error("Operation id already exists with different content");
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      if (pending.sha === sha) {
        return "created";
      }
      throw new Error("Operation id already exists with different content");
    }
    this.pending.set(key, { deviceId, opId, bytes, sha });
    return "created";
  }

  /**
   * Splits the pending buffer into deterministic batches bounded by both the
   * operation count and the total byte limit. Insertion order is preserved so
   * batches are stable across retries. A single operation that cannot fit in
   * one batch fails clearly instead of retrying forever.
   */
  private buildBatches(): ImmutableOperationFile[][] {
    const batches: ImmutableOperationFile[][] = [];
    let current: ImmutableOperationFile[] = [];
    let currentBytes = 0;
    for (const pending of this.pending.values()) {
      if (pending.bytes.byteLength > this.maxBatchBytes) {
        throw new InvalidBatchError(
          `GitHub operation exceeds the batch byte limit: ${pending.opId}`
        );
      }
      const file: ImmutableOperationFile = {
        deviceId: pending.deviceId,
        opId: pending.opId,
        bytes: pending.bytes,
      };
      if (
        current.length > 0 &&
        (current.length >= this.maxOperationsPerBatch ||
          currentBytes + pending.bytes.byteLength > this.maxBatchBytes)
      ) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += pending.bytes.byteLength;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private async sleepBeforeRetry(error: unknown, attempt: number) {
    const retryAfterMilliseconds =
      error instanceof GitHubHttpError && error.retryAfter !== undefined
        ? error.retryAfter * 1000
        : this.backoffMilliseconds(attempt);
    await this.sleep(retryAfterMilliseconds);
  }

  /**
   * Commits all buffered operations in bounded atomic batches and returns the
   * confirmed receipts (device id, operation id, remote content address) for
   * the operations now durably present on the branch. On a racing branch move
   * the remote is re-listed and operations that already landed with identical
   * bytes are dropped; on retryable GitHub failures (rate limits, server
   * errors, network errors) the remaining buffer is retried with the provided
   * retry-after delay or exponential backoff. Non-retryable failures and
   * rewritten remote content propagate immediately. Buffered operations are
   * always preserved on failure so nothing is silently lost. Callers must not
   * acknowledge an operation merely because it was buffered; they acknowledge
   * it only when it appears in a returned receipt.
   */
  async flushUploads(): Promise<FlushReceipt[]> {
    const landed: FlushReceipt[] = [];
    for (let attempt = 1; attempt <= this.maxFlushAttempts; attempt += 1) {
      if (this.pending.size === 0) {
        break;
      }
      const batches = this.buildBatches();
      let failed = false;
      for (const batch of batches) {
        try {
          await this.writer.appendOperations(batch);
        } catch (error) {
          failed = true;
          if (error instanceof BranchMovedError) {
            const remoteFiles = await this.treeReader.listOperationFiles(
              error.freshHeadSha
            );
            landed.push(...this.reconcileRemote(remoteFiles));
          } else if (!classifyGitHubError(error).retryable) {
            throw error;
          }
          if (this.pending.size > 0 && attempt < this.maxFlushAttempts) {
            await this.sleepBeforeRetry(error, attempt);
          }
          break;
        }
        for (const file of batch) {
          const key = this.key(file.deviceId, file.opId);
          const pending = this.pending.get(key);
          if (!pending) {
            continue;
          }
          this.confirmed.set(key, pending.sha);
          this.pending.delete(key);
          landed.push({
            deviceId: file.deviceId,
            opId: file.opId,
            sha: pending.sha,
          });
        }
      }
      if (!failed && this.pending.size === 0) {
        break;
      }
    }
    if (this.pending.size > 0) {
      throw new CommitVerificationError(
        "Giving up after repeated failures during upload"
      );
    }
    return landed;
  }

  private reconcileRemote(remoteFiles: GitHubOperationFile[]): FlushReceipt[] {
    const remoteByKey = new Map(
      remoteFiles.map((file) => [this.key(file.deviceId, file.opId), file.sha])
    );
    const landed: FlushReceipt[] = [];
    for (const [key, pending] of Array.from(this.pending.entries())) {
      const remoteSha = remoteByKey.get(key);
      if (remoteSha === undefined) {
        continue;
      }
      if (remoteSha !== pending.sha) {
        throw new RemoteOperationRewrittenError(
          `A remote operation appeared with different content: ${pending.opId}`
        );
      }
      this.confirmed.set(key, pending.sha);
      this.pending.delete(key);
      landed.push({
        deviceId: pending.deviceId,
        opId: pending.opId,
        sha: pending.sha,
      });
    }
    return landed;
  }

  /**
   * Enumerates remote operations after flushing buffered uploads. Previously
   * confirmed operations that disappeared or changed content address are
   * reported as a typed rewrite failure rather than accepted silently.
   */
  async listOperationFiles(): Promise<RemoteOperationFile[]> {
    await this.flushUploads();
    const head = await this.treeReader.getBranchHead();
    const files = await this.treeReader.listOperationFiles(head.sha);
    const remoteShas = new Map(
      files.map((file) => [this.key(file.deviceId, file.opId), file.sha])
    );
    for (const [key, sha] of this.confirmed) {
      const remoteSha = remoteShas.get(key);
      if (remoteSha === undefined || remoteSha !== sha) {
        throw new RemoteOperationRewrittenError(
          "A previously confirmed remote operation was rewritten or removed"
        );
      }
    }
    return files;
  }

  /**
   * Downloads and strictly decodes one immutable operation envelope by blob
   * sha. The decoded size is bounded and non-UTF-8 or malformed base64 results
   * in a typed decode failure.
   */
  async download(deviceId: string, opId: string, sha: string): Promise<string> {
    assertUuid(deviceId, "Device id");
    assertUuid(opId, "Operation id");
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubBlobDecodeError("GitHub blob sha is invalid");
    }
    const response = await this.client.getJson<GitHubBlobResponse>(
      repoPath(this.owner, this.repository, `git/blobs/${sha}`),
      { maximumBytes: MAX_BLOB_JSON_BYTES }
    );
    const blob = response.value;
    if (
      typeof blob?.sha !== "string" ||
      blob.sha !== sha ||
      typeof blob.encoding !== "string" ||
      blob.encoding !== "base64" ||
      typeof blob.content !== "string"
    ) {
      throw new GitHubBlobDecodeError("GitHub blob response is invalid");
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeGitHubBlobBase64(blob.content, "GitHub blob content");
    } catch (error) {
      throw new GitHubBlobDecodeError(
        error instanceof Error ? error.message : "GitHub blob is not base64"
      );
    }
    if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
      throw new GitHubBlobDecodeError("GitHub blob exceeds the size limit");
    }
    if ((await gitBlobSha(bytes)) !== sha) {
      throw new GitHubBlobDecodeError(
        "GitHub blob content does not match its sha"
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubBlobDecodeError("GitHub blob is not valid UTF-8");
    }
  }
}
