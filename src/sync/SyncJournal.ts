import {
  canonicalStringify,
  reduceOperations,
  SyncEntityType,
  SyncOperationKind,
} from "./OperationReducer";

export interface SyncMutationIntent {
  intentId: string;
  repositoryId: string;
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncOperationKind;
  parents: string[];
  createdAt: number;
  localApplied: boolean;
  materializedOpId?: string;
  supersededByIntentId?: string;
}

export interface OutboxOperation {
  opId: string;
  intentId: string;
  repositoryId: string;
  envelope: string;
  /**
   * Authenticated device path for this immutable operation. Records created
   * before this field was introduced are migrated from the envelope.
   */
  deviceId?: string;
  remoteAcknowledged: boolean;
  /**
   * The remote content address of the acknowledged bytes. Git transports
   * provide the blob SHA. Ops written before this field existed remain valid
   * without it.
   */
  remoteSha?: string;
}

export interface RemoteOperationEnvelope {
  opId: string;
  repositoryId: string;
  deviceId: string;
  envelope: string;
  /** Remote content address of the stored bytes, when the transport provides one. */
  remoteSha?: string;
}

export interface StoredOperationEnvelope {
  opId: string;
  envelope: string;
}

export interface QuarantinedRemoteOperation extends RemoteOperationEnvelope {
  error: string;
}

export interface EntityHeadsRecord {
  key: string;
  repositoryId: string;
  entityType: SyncEntityType;
  entityId: string;
  heads: string[];
}

const INTENTS_STORE = "intents";
const OPERATIONS_STORE = "operations";
const REMOTE_OPERATIONS_STORE = "remoteOperations";
const QUARANTINED_OPERATIONS_STORE = "quarantinedOperations";
const ENTITY_HEADS_STORE = "entityHeads";
const DATABASE_VERSION = 4;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed"));
  });
}

function comparableIntent(intent: SyncMutationIntent) {
  return {
    intentId: intent.intentId,
    repositoryId: intent.repositoryId,
    entityType: intent.entityType,
    entityId: intent.entityId,
    kind: intent.kind,
    parents: intent.parents,
    createdAt: intent.createdAt,
  };
}

function compareById<T extends { intentId?: string; opId?: string }>(
  left: T,
  right: T
) {
  const leftId = left.intentId || left.opId || "";
  const rightId = right.intentId || right.opId || "";
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

export class IndexedDbSyncJournal {
  private database?: IDBDatabase;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(
    private readonly indexedDb: IDBFactory = indexedDB,
    private readonly databaseName = "authenticator-sync"
  ) {}

  private open() {
    if (this.database) {
      return Promise.resolve(this.database);
    }
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(INTENTS_STORE)) {
          database.createObjectStore(INTENTS_STORE, { keyPath: "intentId" });
        }
        if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
          database.createObjectStore(OPERATIONS_STORE, { keyPath: "opId" });
        }
        if (!database.objectStoreNames.contains(REMOTE_OPERATIONS_STORE)) {
          database.createObjectStore(REMOTE_OPERATIONS_STORE, {
            keyPath: "opId",
          });
        }
        if (!database.objectStoreNames.contains(QUARANTINED_OPERATIONS_STORE)) {
          database.createObjectStore(QUARANTINED_OPERATIONS_STORE, {
            keyPath: "opId",
          });
        }
        if (!database.objectStoreNames.contains(ENTITY_HEADS_STORE)) {
          database.createObjectStore(ENTITY_HEADS_STORE, {
            keyPath: "key",
          });
        }
      };
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => this.close();
        resolve(this.database);
      };
      request.onerror = () => {
        this.databasePromise = undefined;
        reject(request.error || new Error("Unable to open sync journal"));
      };
      request.onblocked = () => {
        this.databasePromise = undefined;
        reject(new Error("Sync journal upgrade is blocked"));
      };
    });

    return this.databasePromise;
  }

  async enqueueIntent(intent: SyncMutationIntent) {
    const database = await this.open();
    const transaction = database.transaction(INTENTS_STORE, "readwrite");
    const store = transaction.objectStore(INTENTS_STORE);
    const existing = (await requestResult(store.get(intent.intentId))) as
      | SyncMutationIntent
      | undefined;

    if (
      existing &&
      canonicalStringify(comparableIntent(existing)) !==
        canonicalStringify(comparableIntent(intent))
    ) {
      transaction.abort();
      throw new Error(`Intent id has conflicting content: ${intent.intentId}`);
    }
    if (!existing) {
      store.add(intent);
    }
    await transactionDone(transaction);
  }

  async getIntent(intentId: string) {
    const database = await this.open();
    const transaction = database.transaction(INTENTS_STORE, "readonly");
    const intent = (await requestResult(
      transaction.objectStore(INTENTS_STORE).get(intentId)
    )) as SyncMutationIntent | undefined;
    await transactionDone(transaction);
    return intent;
  }

  async listIntents(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(INTENTS_STORE, "readonly");
    const intents = (await requestResult(
      transaction.objectStore(INTENTS_STORE).getAll()
    )) as SyncMutationIntent[];
    await transactionDone(transaction);
    return intents
      .filter((intent) => intent.repositoryId === repositoryId)
      .sort(compareById);
  }

  async listDirtyIntents(repositoryId: string) {
    const intents = await this.listIntents(repositoryId);
    return intents.filter(
      (intent) =>
        intent.localApplied &&
        !intent.materializedOpId &&
        !intent.supersededByIntentId
    );
  }

  async markIntentSuperseded(intentId: string, supersededByIntentId: string) {
    const database = await this.open();
    const transaction = database.transaction(INTENTS_STORE, "readwrite");
    const store = transaction.objectStore(INTENTS_STORE);
    const intent = (await requestResult(store.get(intentId))) as
      | SyncMutationIntent
      | undefined;
    const superseder = (await requestResult(
      store.get(supersededByIntentId)
    )) as SyncMutationIntent | undefined;
    if (
      !intent ||
      !superseder ||
      !intent.localApplied ||
      !superseder.localApplied ||
      intent.materializedOpId ||
      superseder.materializedOpId ||
      intent.repositoryId !== superseder.repositoryId ||
      intent.entityType !== "otp" ||
      superseder.entityType !== "otp" ||
      intent.entityId !== superseder.entityId ||
      superseder.kind !== "delete"
    ) {
      transaction.abort();
      throw new Error("Dirty intent cannot be superseded by this deletion");
    }
    store.put({ ...intent, supersededByIntentId });
    await transactionDone(transaction);
  }

  async getOperationForIntent(intentId: string) {
    const database = await this.open();
    const transaction = database.transaction(OPERATIONS_STORE, "readonly");
    const operations = (await requestResult(
      transaction.objectStore(OPERATIONS_STORE).getAll()
    )) as OutboxOperation[];
    await transactionDone(transaction);
    return operations.find((operation) => operation.intentId === intentId);
  }

  async markIntentApplied(intentId: string) {
    const database = await this.open();
    const transaction = database.transaction(INTENTS_STORE, "readwrite");
    const store = transaction.objectStore(INTENTS_STORE);
    const intent = (await requestResult(store.get(intentId))) as
      | SyncMutationIntent
      | undefined;
    if (!intent) {
      transaction.abort();
      throw new Error(`Intent does not exist: ${intentId}`);
    }
    store.put({ ...intent, localApplied: true });
    await transactionDone(transaction);
  }

  async materializeIntent(
    intentId: string,
    opId: string,
    envelope: string,
    deviceId?: string
  ) {
    const database = await this.open();
    const transaction = database.transaction(
      [INTENTS_STORE, OPERATIONS_STORE],
      "readwrite"
    );
    const intents = transaction.objectStore(INTENTS_STORE);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    const intent = (await requestResult(intents.get(intentId))) as
      | SyncMutationIntent
      | undefined;
    if (!intent) {
      transaction.abort();
      throw new Error(`Intent does not exist: ${intentId}`);
    }

    if (intent.materializedOpId) {
      const existing = (await requestResult(
        operations.get(intent.materializedOpId)
      )) as OutboxOperation | undefined;
      if (
        !existing ||
        existing.opId !== opId ||
        existing.envelope !== envelope
      ) {
        transaction.abort();
        throw new Error(`Materialized intent bytes cannot change: ${intentId}`);
      }
      if (
        deviceId !== undefined &&
        existing.deviceId !== undefined &&
        existing.deviceId !== deviceId
      ) {
        transaction.abort();
        throw new Error(
          `Materialized intent device cannot change: ${intentId}`
        );
      }
      if (!existing.deviceId && deviceId !== undefined) {
        const migrated = { ...existing, deviceId };
        operations.put(migrated);
        await transactionDone(transaction);
        return migrated;
      }
      await transactionDone(transaction);
      return existing;
    }

    const operation: OutboxOperation = {
      opId,
      intentId,
      repositoryId: intent.repositoryId,
      envelope,
      ...(deviceId === undefined ? {} : { deviceId }),
      remoteAcknowledged: false,
    };
    operations.add(operation);
    intents.put({ ...intent, materializedOpId: opId });
    await transactionDone(transaction);
    return operation;
  }

  async getEntityHeads(
    repositoryId: string,
    entityType: SyncEntityType,
    entityId: string
  ) {
    const database = await this.open();
    const transaction = database.transaction(ENTITY_HEADS_STORE, "readonly");
    const record = (await requestResult(
      transaction
        .objectStore(ENTITY_HEADS_STORE)
        .get(`${repositoryId}:${entityType}:${entityId}`)
    )) as EntityHeadsRecord | undefined;
    await transactionDone(transaction);
    return record ? [...record.heads] : [];
  }

  async advanceEntityHeads(intent: SyncMutationIntent, opId: string) {
    const database = await this.open();
    const transaction = database.transaction(ENTITY_HEADS_STORE, "readwrite");
    const store = transaction.objectStore(ENTITY_HEADS_STORE);
    const key = `${intent.repositoryId}:${intent.entityType}:${intent.entityId}`;
    const current = (await requestResult(store.get(key))) as
      | EntityHeadsRecord
      | undefined;
    const superseded = new Set(intent.parents);
    const heads = new Set(
      (current?.heads ?? intent.parents).filter((head) => !superseded.has(head))
    );
    heads.add(opId);
    const next: EntityHeadsRecord = {
      key,
      repositoryId: intent.repositoryId,
      entityType: intent.entityType,
      entityId: intent.entityId,
      heads: Array.from(heads).sort((left, right) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      }),
    };
    store.put(next);
    await transactionDone(transaction);
  }

  async replaceEntityHeads(
    repositoryId: string,
    operations: Parameters<typeof reduceOperations>[0]
  ) {
    const reduced = reduceOperations(operations, repositoryId);
    if (reduced.pending.length > 0) {
      throw new Error("Cannot persist entity heads with missing dependencies");
    }
    const database = await this.open();
    const transaction = database.transaction(ENTITY_HEADS_STORE, "readwrite");
    const store = transaction.objectStore(ENTITY_HEADS_STORE);
    const existing = (await requestResult(
      store.getAll()
    )) as EntityHeadsRecord[];
    for (const record of existing) {
      if (record.repositoryId === repositoryId) {
        store.delete(record.key);
      }
    }
    for (const entity of reduced.entities) {
      const key = `${repositoryId}:${entity.entityType}:${entity.entityId}`;
      const next: EntityHeadsRecord = {
        key,
        repositoryId,
        entityType: entity.entityType,
        entityId: entity.entityId,
        heads: entity.heads.map((head) => head.opId),
      };
      store.put(next);
    }
    await transactionDone(transaction);
  }

  async quarantineRemoteOperation(operation: QuarantinedRemoteOperation) {
    const database = await this.open();
    const transaction = database.transaction(
      QUARANTINED_OPERATIONS_STORE,
      "readwrite"
    );
    const store = transaction.objectStore(QUARANTINED_OPERATIONS_STORE);
    const existing = (await requestResult(store.get(operation.opId))) as
      | QuarantinedRemoteOperation
      | undefined;
    if (
      existing &&
      (existing.repositoryId !== operation.repositoryId ||
        existing.deviceId !== operation.deviceId ||
        existing.envelope !== operation.envelope)
    ) {
      transaction.abort();
      throw new Error(
        `Quarantined operation id has conflicting bytes: ${operation.opId}`
      );
    }
    if (!existing) {
      store.add(operation);
    }
    await transactionDone(transaction);
  }

  async listQuarantinedOperationIds(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(
      QUARANTINED_OPERATIONS_STORE,
      "readonly"
    );
    const operations = (await requestResult(
      transaction.objectStore(QUARANTINED_OPERATIONS_STORE).getAll()
    )) as QuarantinedRemoteOperation[];
    await transactionDone(transaction);
    return operations
      .filter((operation) => operation.repositoryId === repositoryId)
      .map((operation) => operation.opId)
      .sort((left, right) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      });
  }

  async listRemoteOperations(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(
      REMOTE_OPERATIONS_STORE,
      "readonly"
    );
    const operations = (await requestResult(
      transaction.objectStore(REMOTE_OPERATIONS_STORE).getAll()
    )) as RemoteOperationEnvelope[];
    await transactionDone(transaction);
    return operations
      .filter((operation) => operation.repositoryId === repositoryId)
      .sort(compareById);
  }

  async listLocalOperations(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(OPERATIONS_STORE, "readonly");
    const operations = (await requestResult(
      transaction.objectStore(OPERATIONS_STORE).getAll()
    )) as OutboxOperation[];
    await transactionDone(transaction);
    return operations
      .filter((operation) => operation.repositoryId === repositoryId)
      .sort(compareById);
  }

  async listOutbox(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(
      [INTENTS_STORE, OPERATIONS_STORE],
      "readonly"
    );
    const operations = (await requestResult(
      transaction.objectStore(OPERATIONS_STORE).getAll()
    )) as OutboxOperation[];
    const intents = (await requestResult(
      transaction.objectStore(INTENTS_STORE).getAll()
    )) as SyncMutationIntent[];
    await transactionDone(transaction);
    const appliedIntentIds = new Set(
      intents
        .filter((intent) => intent.localApplied)
        .map((intent) => intent.intentId)
    );
    return operations
      .filter(
        (operation) =>
          operation.repositoryId === repositoryId &&
          !operation.remoteAcknowledged &&
          appliedIntentIds.has(operation.intentId)
      )
      .sort(compareById);
  }

  async attachLocalDeviceId(opId: string, deviceId: string) {
    const database = await this.open();
    const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
    const store = transaction.objectStore(OPERATIONS_STORE);
    const operation = (await requestResult(store.get(opId))) as
      | OutboxOperation
      | undefined;
    if (!operation) {
      transaction.abort();
      throw new Error(`Outbox operation does not exist: ${opId}`);
    }
    if (operation.deviceId !== undefined && operation.deviceId !== deviceId) {
      transaction.abort();
      throw new Error(`Outbox operation has conflicting device id: ${opId}`);
    }
    if (!operation.deviceId) {
      store.put({ ...operation, deviceId });
    }
    await transactionDone(transaction);
  }

  async markRemoteAcknowledged(opId: string, remoteSha?: string) {
    const database = await this.open();
    const transaction = database.transaction(OPERATIONS_STORE, "readwrite");
    const store = transaction.objectStore(OPERATIONS_STORE);
    const operation = (await requestResult(store.get(opId))) as
      | OutboxOperation
      | undefined;
    if (!operation) {
      transaction.abort();
      throw new Error(`Outbox operation does not exist: ${opId}`);
    }
    if (
      operation.remoteSha !== undefined &&
      remoteSha !== undefined &&
      operation.remoteSha !== remoteSha
    ) {
      transaction.abort();
      throw new Error(
        `Outbox operation has conflicting remote content: ${opId}`
      );
    }
    store.put({
      ...operation,
      remoteAcknowledged: true,
      remoteSha: remoteSha ?? operation.remoteSha,
    });
    await transactionDone(transaction);
  }

  /**
   * Attaches a remote content address to an existing local or remote operation
   * that currently has none, or validates a matching one. An existing address
   * that differs fails closed. Records written before this field existed
   * remain valid and acquire the address on their first observation.
   */
  async attachRemoteSha(opId: string, remoteSha: string) {
    if (typeof remoteSha !== "string" || remoteSha.length === 0) {
      throw new Error("Remote content address is invalid");
    }
    const database = await this.open();
    const transaction = database.transaction(
      [OPERATIONS_STORE, REMOTE_OPERATIONS_STORE],
      "readwrite"
    );
    const localOperations = transaction.objectStore(OPERATIONS_STORE);
    const remoteOperations = transaction.objectStore(REMOTE_OPERATIONS_STORE);
    const local = (await requestResult(localOperations.get(opId))) as
      | OutboxOperation
      | undefined;
    if (local) {
      if (local.remoteSha !== undefined && local.remoteSha !== remoteSha) {
        transaction.abort();
        throw new Error(
          `Outbox operation has conflicting remote content: ${opId}`
        );
      }
      if (!local.remoteSha) {
        localOperations.put({ ...local, remoteSha });
      }
      await transactionDone(transaction);
      return;
    }

    const remote = (await requestResult(remoteOperations.get(opId))) as
      | RemoteOperationEnvelope
      | undefined;
    if (!remote) {
      transaction.abort();
      throw new Error(`Stored operation does not exist: ${opId}`);
    }
    if (remote.remoteSha !== undefined && remote.remoteSha !== remoteSha) {
      transaction.abort();
      throw new Error(
        `Remote operation has conflicting remote content: ${opId}`
      );
    }
    if (!remote.remoteSha) {
      remoteOperations.put({ ...remote, remoteSha });
    }
    await transactionDone(transaction);
  }

  async storeRemoteOperation(operation: RemoteOperationEnvelope) {
    const database = await this.open();
    const transaction = database.transaction(
      [OPERATIONS_STORE, REMOTE_OPERATIONS_STORE],
      "readwrite"
    );
    const localOperations = transaction.objectStore(OPERATIONS_STORE);
    const remoteOperations = transaction.objectStore(REMOTE_OPERATIONS_STORE);
    const local = (await requestResult(localOperations.get(operation.opId))) as
      | OutboxOperation
      | undefined;
    if (local) {
      if (
        local.repositoryId !== operation.repositoryId ||
        local.envelope !== operation.envelope
      ) {
        transaction.abort();
        throw new Error(
          `Remote operation conflicts with local bytes: ${operation.opId}`
        );
      }
      if (operation.remoteSha !== undefined && local.remoteSha === undefined) {
        localOperations.put({ ...local, remoteSha: operation.remoteSha });
      } else if (
        operation.remoteSha !== undefined &&
        local.remoteSha !== operation.remoteSha
      ) {
        transaction.abort();
        throw new Error(
          `Remote operation has conflicting remote content: ${operation.opId}`
        );
      }
      await transactionDone(transaction);
      return;
    }

    const existing = (await requestResult(
      remoteOperations.get(operation.opId)
    )) as RemoteOperationEnvelope | undefined;
    if (existing) {
      const comparableExisting = { ...existing };
      const comparableOperation = { ...operation };
      if (comparableExisting.remoteSha === undefined) {
        delete comparableExisting.remoteSha;
      }
      if (comparableOperation.remoteSha === undefined) {
        delete comparableOperation.remoteSha;
      }
      if (
        canonicalStringify(comparableExisting) !==
        canonicalStringify(comparableOperation)
      ) {
        transaction.abort();
        throw new Error(
          `Remote operation id has conflicting content: ${operation.opId}`
        );
      }
      if (
        operation.remoteSha !== undefined &&
        existing.remoteSha === undefined
      ) {
        remoteOperations.put({ ...existing, remoteSha: operation.remoteSha });
      } else if (
        operation.remoteSha !== undefined &&
        existing.remoteSha !== operation.remoteSha
      ) {
        transaction.abort();
        throw new Error(
          `Remote operation has conflicting remote content: ${operation.opId}`
        );
      }
      await transactionDone(transaction);
      return;
    }

    if (!existing) {
      remoteOperations.add(operation);
    }
    await transactionDone(transaction);
  }

  async listKnownOperationIds(repositoryId: string) {
    const envelopes = await this.listStoredEnvelopes(repositoryId);
    return envelopes.map((operation) => operation.opId);
  }

  async listStoredEnvelopes(repositoryId: string) {
    const database = await this.open();
    const transaction = database.transaction(
      [OPERATIONS_STORE, REMOTE_OPERATIONS_STORE],
      "readonly"
    );
    const local = (await requestResult(
      transaction.objectStore(OPERATIONS_STORE).getAll()
    )) as OutboxOperation[];
    const remote = (await requestResult(
      transaction.objectStore(REMOTE_OPERATIONS_STORE).getAll()
    )) as RemoteOperationEnvelope[];
    await transactionDone(transaction);

    const envelopes = new Map<string, string>();
    for (const operation of [...local, ...remote]) {
      if (operation.repositoryId !== repositoryId) {
        continue;
      }
      const existing = envelopes.get(operation.opId);
      if (existing !== undefined && existing !== operation.envelope) {
        throw new Error(
          `Stored operation id has conflicting bytes: ${operation.opId}`
        );
      }
      envelopes.set(operation.opId, operation.envelope);
    }
    return Array.from(envelopes, ([opId, envelope]) => ({
      opId,
      envelope,
    })).sort((left, right) => compareById(left, right));
  }

  async deleteRepositoryData(repositoryId: string) {
    const database = await this.open();
    const storeNames = [
      INTENTS_STORE,
      OPERATIONS_STORE,
      REMOTE_OPERATIONS_STORE,
      QUARANTINED_OPERATIONS_STORE,
      ENTITY_HEADS_STORE,
    ];
    const transaction = database.transaction(storeNames, "readwrite");
    for (const storeName of storeNames) {
      const store = transaction.objectStore(storeName);
      const records = (await requestResult(store.getAll())) as Array<
        Record<string, unknown>
      >;
      for (const record of records) {
        if (record.repositoryId !== repositoryId) {
          continue;
        }
        if (storeName === INTENTS_STORE) {
          store.delete(record.intentId as IDBValidKey);
        } else if (storeName === ENTITY_HEADS_STORE) {
          store.delete(record.key as IDBValidKey);
        } else {
          store.delete(record.opId as IDBValidKey);
        }
      }
    }
    await transactionDone(transaction);
  }

  close() {
    this.database?.close();
    this.database = undefined;
    this.databasePromise = undefined;
  }

  async deleteDatabase() {
    this.close();
    await requestResult(this.indexedDb.deleteDatabase(this.databaseName));
  }
}
