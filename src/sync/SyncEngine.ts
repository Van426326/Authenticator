import {
  SyncRunResult,
  SyncRunner,
  SyncTriggerReason,
} from "./SyncRunController";
import { SyncOperation } from "./OperationReducer";
import { deriveSyncState, DerivedSyncState } from "./SyncState";
import { openOperationEnvelope, SyncEncryptionMode } from "./SyncCrypto";
import {
  OutboxOperation,
  QuarantinedRemoteOperation,
  RemoteOperationEnvelope,
  StoredOperationEnvelope,
  SyncMutationIntent,
} from "./SyncJournal";
import {
  FlushReceipt,
  RemoteHistoryRewrittenError,
  SyncEngineOperationStore,
} from "./SyncEngineTypes";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function compareStrings(left: string, right: string) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export interface SyncRepositorySession {
  repositoryId: string;
  mode: SyncEncryptionMode;
  initialized: boolean;
  dataKey?: Uint8Array;
}

export interface SyncRepositorySessionProvider {
  getSession(): Promise<SyncRepositorySession>;
}

export interface SyncEngineJournal {
  listOutbox(repositoryId: string): Promise<OutboxOperation[]>;
  listDirtyIntents(repositoryId: string): Promise<SyncMutationIntent[]>;
  materializeIntent(
    intentId: string,
    opId: string,
    envelope: string,
    deviceId: string
  ): Promise<OutboxOperation>;
  markIntentSuperseded(
    intentId: string,
    supersededByIntentId: string
  ): Promise<void>;
  advanceEntityHeads(intent: SyncMutationIntent, opId: string): Promise<void>;
  replaceEntityHeads(
    repositoryId: string,
    operations: SyncOperation[]
  ): Promise<void>;
  listLocalOperations(repositoryId: string): Promise<OutboxOperation[]>;
  listRemoteOperations(
    repositoryId: string
  ): Promise<RemoteOperationEnvelope[]>;
  markRemoteAcknowledged(opId: string, remoteSha?: string): Promise<void>;
  attachLocalDeviceId(opId: string, deviceId: string): Promise<void>;
  attachRemoteSha(opId: string, remoteSha: string): Promise<void>;
  listKnownOperationIds(repositoryId: string): Promise<string[]>;
  listQuarantinedOperationIds(repositoryId: string): Promise<string[]>;
  quarantineRemoteOperation(
    operation: QuarantinedRemoteOperation
  ): Promise<void>;
  storeRemoteOperation(operation: RemoteOperationEnvelope): Promise<void>;
  listStoredEnvelopes(repositoryId: string): Promise<StoredOperationEnvelope[]>;
}

export interface MaterializedSyncIntent {
  opId: string;
  envelope: string;
}

export interface SyncEngineLocalAdapter {
  isUnlocked(): Promise<boolean>;
  materializeIntent(
    intent: SyncMutationIntent,
    session: SyncRepositorySession
  ): Promise<MaterializedSyncIntent>;
  ensureSeeded(
    operations: SyncOperation[],
    session: SyncRepositorySession
  ): Promise<boolean>;
  applyDerivedState(
    state: DerivedSyncState,
    isCurrent: () => Promise<boolean>,
    afterApply: () => Promise<void>
  ): Promise<boolean>;
}

export class DirtyIntentAccountMissingError extends Error {
  constructor(readonly intentId: string) {
    super(`Dirty intent account no longer exists: ${intentId}`);
    this.name = "DirtyIntentAccountMissingError";
  }
}

export class RemoteOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteOperationValidationError";
  }
}

async function openStoredEnvelope(
  envelope: string,
  session: SyncRepositorySession,
  description: string
) {
  try {
    return await openOperationEnvelope(envelope, session.mode, session.dataKey);
  } catch (error) {
    throw new RemoteOperationValidationError(
      `${description}: ${
        error instanceof Error ? error.message : "invalid data"
      }`
    );
  }
}

function assertSession(session: SyncRepositorySession, localDeviceId: string) {
  if (!UUID_V4.test(session.repositoryId) || !UUID_V4.test(localDeviceId)) {
    throw new Error("Sync repository or device id is invalid");
  }
  if (session.mode !== "none" && session.mode !== "aes-256-gcm") {
    throw new Error("Sync repository encryption mode is invalid");
  }
  if (typeof session.initialized !== "boolean") {
    throw new Error("Sync repository initialization state is invalid");
  }
  if (session.dataKey !== undefined && session.dataKey.byteLength !== 32) {
    throw new Error("Sync repository data key is invalid");
  }
}

export class SyncEngine implements SyncRunner {
  constructor(
    private readonly sessions: SyncRepositorySessionProvider,
    private readonly journal: SyncEngineJournal,
    private readonly remote: SyncEngineOperationStore,
    private readonly local: SyncEngineLocalAdapter,
    private readonly localDeviceId: string
  ) {}

  private async acknowledgeReceipts(
    receipts: FlushReceipt[],
    uploaded: Set<string>
  ) {
    for (const receipt of receipts) {
      if (uploaded.has(receipt.opId)) {
        await this.journal.markRemoteAcknowledged(receipt.opId, receipt.sha);
      }
    }
  }

  async run(reasons: SyncTriggerReason[]): Promise<SyncRunResult> {
    void reasons;
    const session = await this.sessions.getSession();
    assertSession(session, this.localDeviceId);

    // Phase 1: read the remote listing. For Git transports this is a pure
    // read; nothing is written during the listing itself.
    const remoteFiles = await this.remote.listOperationFiles();
    const remotePaths = new Map<string, string>();
    const remoteShas = new Map<string, string>();
    for (const file of remoteFiles) {
      const existingDevice = remotePaths.get(file.opId);
      if (existingDevice && existingDevice !== file.deviceId) {
        throw new RemoteOperationValidationError(
          `Remote operation appears under multiple devices: ${file.opId}`
        );
      }
      remotePaths.set(file.opId, file.deviceId);
      if (file.sha !== undefined) {
        remoteShas.set(file.opId, file.sha);
      }
    }

    // Phase 2: collect durable known operations from the journal. These were
    // confirmed or observed durably before and are the history the policy
    // reconciles against. Unacknowledged outbox operations are pending writes,
    // not durable history.
    const localOperations = await this.journal.listLocalOperations(
      session.repositoryId
    );
    // Older journal records did not persist the authenticated device path.
    // Recover it once from the immutable envelope. This is local metadata
    // migration, not remote-history repair: a moved modern record still fails
    // closed below, and missing durable remote operations are never accepted.
    for (const operation of localOperations) {
      if (operation.deviceId !== undefined) {
        continue;
      }
      if (operation.remoteAcknowledged && !remotePaths.has(operation.opId)) {
        // Let the durable missing-history check report the stronger failure.
        continue;
      }
      if (session.mode === "aes-256-gcm" && !session.dataKey) {
        return { status: "needsSyncPassword" };
      }
      const authenticated = await openStoredEnvelope(
        operation.envelope,
        session,
        `Invalid legacy local operation ${operation.opId}`
      );
      if (
        authenticated.repositoryId !== session.repositoryId ||
        authenticated.opId !== operation.opId
      ) {
        throw new RemoteOperationValidationError(
          `Legacy local operation metadata does not match its envelope: ${operation.opId}`
        );
      }
      await this.journal.attachLocalDeviceId(
        operation.opId,
        authenticated.deviceId
      );
      operation.deviceId = authenticated.deviceId;
    }

    const remoteOperations = await this.journal.listRemoteOperations(
      session.repositoryId
    );
    const durableKnown = [
      ...localOperations
        .filter(
          (operation) =>
            operation.repositoryId === session.repositoryId &&
            operation.remoteAcknowledged
        )
        .map((operation) => ({
          opId: operation.opId,
          deviceId: operation.deviceId ?? this.localDeviceId,
          envelope: operation.envelope,
          remoteSha: operation.remoteSha,
        })),
      ...remoteOperations
        .filter((operation) => operation.repositoryId === session.repositoryId)
        .map((operation) => ({
          opId: operation.opId,
          deviceId: operation.deviceId,
          envelope: operation.envelope,
          remoteSha: operation.remoteSha,
        })),
    ];

    // Phase 3: enforce the remote-history policy BEFORE any write. Durable
    // known operations missing from the remote, moved to another device path,
    // or changed content address are treated as a remote-history rewrite and
    // stop the run with no upload or acknowledge.
    for (const operation of durableKnown) {
      const remoteDevice = remotePaths.get(operation.opId);
      if (remoteDevice === undefined) {
        throw new RemoteHistoryRewrittenError(
          `Remote operation is missing from the branch: ${operation.opId}`
        );
      }
      if (remoteDevice !== operation.deviceId) {
        throw new RemoteHistoryRewrittenError(
          `Remote operation moved to another device path: ${operation.opId}`
        );
      }
      const listingSha = remoteShas.get(operation.opId);
      if (listingSha === undefined) {
        throw new RemoteHistoryRewrittenError(
          `Remote operation has no content address: ${operation.opId}`
        );
      }
      if (operation.remoteSha !== undefined) {
        if (operation.remoteSha !== listingSha) {
          throw new RemoteHistoryRewrittenError(
            `Remote operation content changed: ${operation.opId}`
          );
        }
      } else {
        // First observation: download by the listing content address and
        // verify the exact stored bytes before persisting the address.
        const downloaded = await this.remote.download(
          operation.deviceId,
          operation.opId,
          listingSha
        );
        if (downloaded !== operation.envelope) {
          throw new RemoteHistoryRewrittenError(
            `Remote operation bytes differ from the stored copy: ${operation.opId}`
          );
        }
        await this.journal.attachRemoteSha(operation.opId, listingSha);
      }
    }

    // Phase 4: upload the pending outbox. Uploads may be buffered; durability
    // is established only when a later flush confirms them.
    const outbox = await this.journal.listOutbox(session.repositoryId);
    const outboxUploaded = new Set<string>();
    for (const operation of outbox) {
      if (operation.repositoryId !== session.repositoryId) {
        throw new Error("Outbox operation belongs to another repository");
      }
      if (!operation.deviceId) {
        throw new Error("Outbox operation has no authenticated device id");
      }
      await this.remote.upload(
        operation.deviceId,
        operation.opId,
        operation.envelope
      );
      outboxUploaded.add(operation.opId);
    }

    // Phase 5: flush buffered uploads and acknowledge only the confirmed
    // receipts. An operation is never acknowledged merely because it was
    // buffered.
    const uploadedIds = new Set(outboxUploaded);
    if (uploadedIds.size > 0) {
      const receipts = await this.remote.flushUploads();
      await this.acknowledgeReceipts(receipts, outboxUploaded);
    }

    if (session.mode === "aes-256-gcm" && !session.dataKey) {
      return { status: "needsSyncPassword" };
    }
    if (!(await this.local.isUnlocked())) {
      return { status: "needsLocalUnlock" };
    }
    if (!session.initialized) {
      return { status: "initializing" };
    }

    // Phase 7: materialize and upload dirty intents, then flush and
    // acknowledge only the confirmed receipts.
    const dirtyIntents = await this.journal.listDirtyIntents(
      session.repositoryId
    );
    const dirtyUploaded = new Set<string>();
    for (const intent of dirtyIntents) {
      let materialized: MaterializedSyncIntent;
      try {
        materialized = await this.local.materializeIntent(intent, session);
      } catch (error) {
        if (!(error instanceof DirtyIntentAccountMissingError)) {
          throw error;
        }
        const supersedingDelete = dirtyIntents.find(
          (candidate) =>
            candidate.repositoryId === intent.repositoryId &&
            candidate.entityType === "otp" &&
            candidate.entityId === intent.entityId &&
            candidate.kind === "delete" &&
            candidate.createdAt >= intent.createdAt
        );
        if (!supersedingDelete) {
          throw error;
        }
        await this.journal.markIntentSuperseded(
          intent.intentId,
          supersedingDelete.intentId
        );
        continue;
      }
      const operation = await openOperationEnvelope(
        materialized.envelope,
        session.mode,
        session.dataKey
      );
      if (
        operation.repositoryId !== intent.repositoryId ||
        operation.deviceId !== this.localDeviceId ||
        operation.entityType !== intent.entityType ||
        operation.entityId !== intent.entityId ||
        operation.kind !== intent.kind ||
        operation.parents.length !== intent.parents.length ||
        operation.parents.some(
          (parent, index) => parent !== intent.parents[index]
        ) ||
        operation.opId !== materialized.opId
      ) {
        throw new Error(
          `Materialized operation does not match intent: ${intent.intentId}`
        );
      }
      await this.journal.materializeIntent(
        intent.intentId,
        materialized.opId,
        materialized.envelope,
        operation.deviceId
      );
      await this.journal.advanceEntityHeads(intent, materialized.opId);
      await this.remote.upload(
        this.localDeviceId,
        materialized.opId,
        materialized.envelope
      );
      dirtyUploaded.add(materialized.opId);
    }
    if (dirtyUploaded.size > 0) {
      const receipts = await this.remote.flushUploads();
      await this.acknowledgeReceipts(receipts, dirtyUploaded);
    }

    const quarantinedIds = new Set(
      await this.journal.listQuarantinedOperationIds(session.repositoryId)
    );
    let hasQuarantinedOperations = quarantinedIds.size > 0;
    const knownIds = new Set([
      ...(await this.journal.listKnownOperationIds(session.repositoryId)),
      ...quarantinedIds,
    ]);
    for (const file of remoteFiles) {
      if (knownIds.has(file.opId)) {
        continue;
      }
      const envelope = await this.remote.download(
        file.deviceId,
        file.opId,
        file.sha
      );
      try {
        const operation = await openStoredEnvelope(
          envelope,
          session,
          `Invalid remote operation ${file.opId}`
        );
        if (
          operation.repositoryId !== session.repositoryId ||
          operation.opId !== file.opId ||
          operation.deviceId !== file.deviceId
        ) {
          throw new RemoteOperationValidationError(
            `Remote operation path does not match its authenticated payload: ${file.opId}`
          );
        }
      } catch (error) {
        await this.journal.quarantineRemoteOperation({
          repositoryId: session.repositoryId,
          deviceId: file.deviceId,
          opId: file.opId,
          envelope,
          error:
            error instanceof Error ? error.message : "Invalid remote operation",
        });
        quarantinedIds.add(file.opId);
        knownIds.add(file.opId);
        hasQuarantinedOperations = true;
        continue;
      }
      await this.journal.storeRemoteOperation({
        repositoryId: session.repositoryId,
        deviceId: file.deviceId,
        opId: file.opId,
        envelope,
        remoteSha: file.sha,
      });
      knownIds.add(file.opId);
    }

    const stored = await this.journal.listStoredEnvelopes(session.repositoryId);
    const operations: SyncOperation[] = [];
    for (const record of stored) {
      const operation = await openStoredEnvelope(
        record.envelope,
        session,
        `Invalid stored operation ${record.opId}`
      );
      if (
        operation.repositoryId !== session.repositoryId ||
        operation.opId !== record.opId
      ) {
        throw new RemoteOperationValidationError(
          `Stored operation metadata does not match its payload: ${record.opId}`
        );
      }
      operations.push(operation);
    }

    if (!(await this.local.ensureSeeded(operations, session))) {
      return { status: "initializing" };
    }
    if (operations.length === 0) {
      return {
        status: hasQuarantinedOperations ? "remoteCorrupt" : "synced",
      };
    }

    const state = deriveSyncState(operations, session.repositoryId);
    if (state.pending.length > 0) {
      return {
        status: hasQuarantinedOperations ? "remoteCorrupt" : "remoteIncomplete",
      };
    }
    const expectedOperationIds = operations
      .map((operation) => operation.opId)
      .sort(compareStrings);
    const applied = await this.local.applyDerivedState(
      state,
      async () => {
        const currentOperationIds = (
          await this.journal.listStoredEnvelopes(session.repositoryId)
        )
          .map((operation) => operation.opId)
          .sort(compareStrings);
        return (
          currentOperationIds.length === expectedOperationIds.length &&
          currentOperationIds.every(
            (opId, index) => opId === expectedOperationIds[index]
          )
        );
      },
      () => this.journal.replaceEntityHeads(session.repositoryId, operations)
    );
    if (!applied) {
      return { status: "pending" };
    }
    if (hasQuarantinedOperations) {
      return { status: "remoteCorrupt" };
    }
    return {
      status: state.conflicts.length > 0 ? "conflict" : "synced",
    };
  }
}
