import { SyncOperation } from "./OperationReducer";
import { openOperationEnvelope } from "./SyncCrypto";
import { StoredOperationEnvelope } from "./SyncJournal";
import { deriveSyncState } from "./SyncState";
import { SyncRepositorySessionProvider } from "./SyncEngine";

export interface ConflictJournal {
  listStoredEnvelopes(repositoryId: string): Promise<StoredOperationEnvelope[]>;
}

export interface SyncConflictBranch {
  opId: string;
  deviceId: string;
  createdAt: number;
  deleted: boolean;
  payload?: unknown;
}

export interface SyncConflictSummary {
  entityType: "otp" | "order";
  entityId: string;
  branches: SyncConflictBranch[];
}

function resolutionPayload(operation: SyncOperation) {
  if (operation.kind === "delete") {
    return { deleted: true, payload: undefined };
  }
  if (
    operation.kind === "resolve" &&
    operation.payload &&
    typeof operation.payload === "object" &&
    "resolution" in operation.payload
  ) {
    if (operation.payload.resolution === "delete") {
      return { deleted: true, payload: undefined };
    }
    if (
      operation.payload.resolution === "upsert" &&
      "entry" in operation.payload
    ) {
      return { deleted: false, payload: operation.payload.entry };
    }
  }
  return { deleted: false, payload: operation.payload };
}

export interface ConflictLocalAccountState {
  isUnlocked(): Promise<boolean>;
}

export class SyncConflictService {
  constructor(
    private readonly journal: ConflictJournal,
    private readonly sessions: SyncRepositorySessionProvider,
    private readonly localAccounts: ConflictLocalAccountState = {
      isUnlocked: async () => true,
    }
  ) {}

  async list(): Promise<SyncConflictSummary[]> {
    const session = await this.sessions.getSession();
    if (session.mode === "aes-256-gcm" && !session.dataKey) {
      return [];
    }
    const stored = await this.journal.listStoredEnvelopes(session.repositoryId);
    const operations = await Promise.all(
      stored.map((record) =>
        openOperationEnvelope(record.envelope, session.mode, session.dataKey)
      )
    );
    const state = deriveSyncState(operations, session.repositoryId);
    const exposePayload = await this.localAccounts.isUnlocked();
    return state.conflicts.map((conflict) => ({
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      branches: conflict.heads.map((operation) => {
        const resolution = resolutionPayload(operation);
        return {
          opId: operation.opId,
          deviceId: operation.deviceId,
          createdAt: operation.createdAt,
          deleted: resolution.deleted,
          payload: exposePayload ? resolution.payload : undefined,
        };
      }),
    }));
  }
}
