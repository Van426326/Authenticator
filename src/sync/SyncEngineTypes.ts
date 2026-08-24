/**
 * Transport-neutral types shared by every remote synchronization transport.
 * The GitHub transport implements the operation store seam defined here and
 * consumed by the sync engine.
 */

export interface RemoteOperationFile {
  deviceId: string;
  opId: string;
  /**
   * The remote content address of the immutable operation bytes. Git
   * transports always provide the blob SHA so callers can detect rewrites.
   */
  sha?: string;
}

/**
 * A confirmed remote write returned by `flushUploads`. The engine acknowledges
 * an operation only when it appears in a flush receipt, never merely because
 * `upload` buffered it.
 */
export interface FlushReceipt {
  deviceId: string;
  opId: string;
  /** The remote content address once the bytes are durably present. */
  sha?: string;
}

/**
 * Thrown when the remote history diverges from what the local journal holds
 * durable. A missing remote operation, a path moved to another device, or a
 * changed content address is never treated as a legitimate delete; the run
 * stops with no upload or acknowledge (fail-closed).
 */
export class RemoteHistoryRewrittenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteHistoryRewrittenError";
  }
}

/**
 * The operation store seam: the transport-neutral contract the GitHub adapter
 * implements and the sync engine drives.
 */
export interface SyncEngineOperationStore {
  /**
   * Buffers or directly performs one immutable upload. Returns "created" when
   * the operation is new and "exists" when identical bytes are already present
   * or buffered. Buffering must not be treated as durability by callers.
   */
  upload(
    deviceId: string,
    opId: string,
    envelope: string | Uint8Array
  ): Promise<"created" | "exists">;
  /**
   * Makes buffered uploads durably present and returns the confirmed receipts.
   * The engine must acknowledge an operation only after it appears here.
   */
  flushUploads(): Promise<FlushReceipt[]>;
  /** Read-only enumeration of remote operations. Must have no write side effects. */
  listOperationFiles(): Promise<RemoteOperationFile[]>;
  /**
   * Downloads exact immutable bytes. The content address (when known) may be
   * supplied so Git transports can fetch by blob SHA and verify it.
   */
  download(deviceId: string, opId: string, sha?: string): Promise<string>;
}
