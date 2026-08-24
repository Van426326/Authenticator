import { AccountMutation } from "./SyncCoordinator";
import { createOperation, createOperationEnvelope } from "./SyncCrypto";
import { SyncEntityType, SyncOperationKind } from "./OperationReducer";
import { SyncRepositorySessionProvider } from "./SyncEngine";
export interface SyncMutationCommand {
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncOperationKind;
  logicalPayload?: unknown;
}

export interface SyncMutationConnection {
  repositoryId: string;
  initialized: boolean;
}

export interface SyncMutationConnectionProvider {
  get(): Promise<SyncMutationConnection | undefined>;
}

export interface SyncEntityHeadsReader {
  getEntityHeads(
    repositoryId: string,
    entityType: SyncEntityType,
    entityId: string
  ): Promise<string[]>;
}

function assertCommand(command: SyncMutationCommand) {
  if (
    (command.entityType !== "otp" && command.entityType !== "order") ||
    (command.kind !== "upsert" &&
      command.kind !== "delete" &&
      command.kind !== "resolve") ||
    typeof command.entityId !== "string" ||
    command.entityId.length === 0 ||
    command.entityId.length > 256
  ) {
    throw new Error("Sync mutation command is invalid");
  }
  if (command.entityType === "order" && command.entityId !== "global-order") {
    throw new Error("Order mutation must target the global order entity");
  }
}

export class SyncMutationFactory {
  constructor(
    private readonly connections: SyncMutationConnectionProvider,
    private readonly sessions: SyncRepositorySessionProvider,
    private readonly heads: SyncEntityHeadsReader,
    private readonly deviceId: string,
    private readonly now: () => number = Date.now
  ) {}

  async create(
    command: SyncMutationCommand
  ): Promise<AccountMutation | undefined> {
    assertCommand(command);
    const connection = await this.connections.get();
    if (!connection) {
      return undefined;
    }
    if (!connection.initialized) {
      throw new Error("Sync repository initialization is incomplete");
    }
    const session = await this.sessions.getSession();
    if (session.repositoryId !== connection.repositoryId) {
      throw new Error("Sync repository session does not match its connection");
    }
    const createdAt = this.now();
    const parents = await this.heads.getEntityHeads(
      connection.repositoryId,
      command.entityType,
      command.entityId
    );
    const intent = {
      intentId: crypto.randomUUID(),
      repositoryId: connection.repositoryId,
      entityType: command.entityType,
      entityId: command.entityId,
      kind: command.kind,
      parents,
      createdAt,
      localApplied: false,
    };
    const operation = await createOperation({
      formatVersion: 1,
      opId: crypto.randomUUID(),
      repositoryId: connection.repositoryId,
      deviceId: this.deviceId,
      entityType: command.entityType,
      entityId: command.entityId,
      kind: command.kind,
      parents,
      createdAt,
      payload: command.logicalPayload,
    });
    if (session.mode === "aes-256-gcm" && !session.dataKey) {
      return { intent, logicalPayload: command.logicalPayload };
    }
    return {
      intent,
      logicalPayload: command.logicalPayload,
      materialized: {
        opId: operation.opId,
        deviceId: operation.deviceId,
        envelope: await createOperationEnvelope(
          operation,
          session.mode,
          session.dataKey
        ),
      },
    };
  }
}
