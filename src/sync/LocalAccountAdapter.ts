import { Encryption } from "../models/encryption";
import { OTPAlgorithm, OTPEntry, OTPType } from "../models/otp";
import { EntryStorage } from "../models/storage";
import { accountWriteMutex, AsyncMutexPermit } from "./AsyncMutex";
import {
  AccountMutation,
  LocalAccountAdapter,
  MaterializedMutation,
} from "./SyncCoordinator";
import {
  createOperation,
  createOperationEnvelope,
  openOperationEnvelope,
} from "./SyncCrypto";
import {
  LogicalOtpPayload,
  deriveSyncState,
  DerivedSyncState,
} from "./SyncState";
import { SyncMutationIntent } from "./SyncJournal";
import {
  DirtyIntentAccountMissingError,
  MaterializedSyncIntent,
  SyncEngineLocalAdapter,
  SyncRepositorySession,
  SyncRepositorySessionProvider,
} from "./SyncEngine";
import { canonicalStringify, SyncOperation } from "./OperationReducer";

export interface LocalEntryStore {
  get(): Promise<OTPEntry[]>;
  replace(entries: OTPEntry[], permit?: AsyncMutexPermit): Promise<void>;
  hasEncryptionKey(): Promise<boolean>;
}

export interface LocalEncryptionProvider {
  getEncryption(): Promise<Encryption | undefined>;
}

export interface SeedMutationWriter {
  mutate(mutation: AccountMutation): Promise<void>;
}

export class LocalAccountsLockedError extends Error {
  constructor() {
    super("Local accounts must be unlocked for synchronization");
    this.name = "LocalAccountsLockedError";
  }
}

const entryStoragePort: LocalEntryStore = {
  get: () => EntryStorage.get(),
  replace: (entries, permit) => EntryStorage.replace(entries, permit),
  hasEncryptionKey: () => EntryStorage.hasEncryptionKey(),
};

export class ChromeSessionEncryptionProvider
  implements LocalEncryptionProvider {
  async getEncryption() {
    const session = await chrome.storage.session.get([
      "cachedPassphrase",
      "cachedKeyId",
    ]);
    if (
      typeof session.cachedPassphrase !== "string" ||
      session.cachedPassphrase.length === 0 ||
      typeof session.cachedKeyId !== "string" ||
      session.cachedKeyId.length === 0
    ) {
      return undefined;
    }
    return new Encryption(session.cachedPassphrase, session.cachedKeyId);
  }
}

function toLogicalPayload(entry: OTPEntry): LogicalOtpPayload {
  if (!entry.secret) {
    throw new LocalAccountsLockedError();
  }
  const payload: LogicalOtpPayload = {
    type: OTPType[entry.type] as LogicalOtpPayload["type"],
    secret: entry.secret,
  };
  if (entry.issuer) {
    payload.issuer = entry.issuer;
  }
  if (entry.account) {
    payload.account = entry.account;
  }
  if (entry.type === OTPType.hotp || entry.type === OTPType.hhex) {
    payload.counter = entry.counter;
  }
  if (entry.type === OTPType.totp && entry.period !== 30) {
    payload.period = entry.period;
  }
  if (entry.digits !== 6) {
    payload.digits = entry.digits;
  }
  if (entry.algorithm !== OTPAlgorithm.SHA1) {
    payload.algorithm = OTPAlgorithm[entry.algorithm];
  }
  if (entry.pinned) {
    payload.pinned = true;
  }
  return payload;
}

function requireOtpPayload(payload: unknown): LogicalOtpPayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    !("secret" in payload) ||
    typeof payload.type !== "string" ||
    typeof payload.secret !== "string"
  ) {
    throw new Error("Account mutation has an invalid OTP payload");
  }
  return payload as LogicalOtpPayload;
}

function unwrapMutationPayload(mutation: AccountMutation): unknown {
  if (
    mutation.intent.kind === "resolve" &&
    mutation.logicalPayload !== null &&
    typeof mutation.logicalPayload === "object" &&
    "resolution" in mutation.logicalPayload
  ) {
    if (mutation.logicalPayload.resolution === "delete") {
      return null;
    }
    if (
      mutation.logicalPayload.resolution === "upsert" &&
      "entry" in mutation.logicalPayload
    ) {
      return mutation.logicalPayload.entry;
    }
  }
  return mutation.logicalPayload;
}

function createEntry(
  id: string,
  index: number,
  payload: LogicalOtpPayload,
  encryption: Encryption | undefined
) {
  const type = OTPType[payload.type];
  const algorithm = payload.algorithm
    ? OTPAlgorithm[payload.algorithm as keyof typeof OTPAlgorithm]
    : OTPAlgorithm.SHA1;
  if (typeof type !== "number" || typeof algorithm !== "number") {
    throw new Error(
      "Account mutation has an unsupported OTP type or algorithm"
    );
  }
  const entry = new OTPEntry({
    account: payload.account,
    algorithm,
    counter: payload.counter,
    digits: payload.digits,
    encrypted: false,
    hash: id,
    index,
    issuer: payload.issuer,
    period: payload.period,
    pinned: payload.pinned,
    secret: payload.secret,
    type,
  });
  if (encryption) {
    entry.changeEncryption(encryption);
  }
  return entry;
}

function requireOrder(payload: unknown) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ids" in payload) ||
    !Array.isArray(payload.ids) ||
    !payload.ids.every((id) => typeof id === "string")
  ) {
    throw new Error("Account mutation has an invalid order payload");
  }
  return payload.ids;
}

function comparePayloads(left: LogicalOtpPayload, right: LogicalOtpPayload) {
  return canonicalStringify(left) === canonicalStringify(right);
}

export class AuthenticatorLocalAccountAdapter
  implements LocalAccountAdapter, SyncEngineLocalAdapter {
  constructor(
    private readonly storage: LocalEntryStore = entryStoragePort,
    private readonly encryptionProvider: LocalEncryptionProvider = new ChromeSessionEncryptionProvider(),
    private readonly seedWriter?: SeedMutationWriter,
    private readonly recoverySessions?: SyncRepositorySessionProvider,
    private readonly deviceId?: string
  ) {}

  private async getEncryptionForWrite() {
    if (!(await this.storage.hasEncryptionKey())) {
      return undefined;
    }
    const encryption = await this.encryptionProvider.getEncryption();
    if (!encryption) {
      throw new LocalAccountsLockedError();
    }
    return encryption;
  }

  private async getUnlockedEntries() {
    const entries = await this.storage.get();
    const encryption = await this.getEncryptionForWrite();
    for (const entry of entries) {
      if (!entry.secret && encryption) {
        entry.applyEncryption(encryption);
      }
      if (!entry.secret) {
        throw new LocalAccountsLockedError();
      }
    }
    return { entries, encryption };
  }

  async isUnlocked() {
    try {
      await this.getUnlockedEntries();
      return true;
    } catch (error) {
      if (error instanceof LocalAccountsLockedError) {
        return false;
      }
      throw error;
    }
  }

  private async applyLogicalMutation(
    mutation: AccountMutation,
    permit: AsyncMutexPermit
  ) {
    const entries = await this.storage.get();
    const payload = unwrapMutationPayload(mutation);

    if (mutation.intent.entityType === "order") {
      const ids = requireOrder(payload);
      const byId = new Map(entries.map((entry) => [entry.hash, entry]));
      const ordered = ids.flatMap((id) => {
        const entry = byId.get(id);
        if (!entry) {
          return [];
        }
        byId.delete(id);
        return [entry];
      });
      ordered.push(...entries.filter((entry) => byId.has(entry.hash)));
      ordered.forEach((entry, index) => {
        entry.index = index;
      });
      await this.storage.replace(ordered, permit);
      return;
    }

    const existingIndex = entries.findIndex(
      (entry) => entry.hash === mutation.intent.entityId
    );
    if (mutation.intent.kind === "delete" || payload === null) {
      if (existingIndex >= 0) {
        entries.splice(existingIndex, 1);
      }
      entries.forEach((entry, index) => {
        entry.index = index;
      });
      await this.storage.replace(entries, permit);
      return;
    }

    const encryption = await this.getEncryptionForWrite();
    const index =
      existingIndex >= 0 ? entries[existingIndex].index : entries.length;
    const replacement = createEntry(
      mutation.intent.entityId,
      index,
      requireOtpPayload(payload),
      encryption
    );
    if (existingIndex >= 0) {
      entries[existingIndex] = replacement;
    } else {
      entries.push(replacement);
    }
    await this.storage.replace(entries, permit);
  }

  applyMutation(mutation: AccountMutation, permit: AsyncMutexPermit) {
    return this.applyLogicalMutation(mutation, permit);
  }

  async recoverIntent(
    intent: SyncMutationIntent,
    materialized: MaterializedMutation | undefined,
    permit: AsyncMutexPermit
  ) {
    if (!materialized || !this.recoverySessions) {
      if (intent.kind === "delete") {
        const entries = await this.storage.get();
        return !entries.some((entry) => entry.hash === intent.entityId);
      }
      return false;
    }
    if (!(await this.isUnlocked())) {
      return false;
    }
    const session = await this.recoverySessions.getSession();
    if (session.repositoryId !== intent.repositoryId) {
      return false;
    }
    if (session.mode === "aes-256-gcm" && !session.dataKey) {
      return false;
    }
    const operation = await openOperationEnvelope(
      materialized.envelope,
      session.mode,
      session.dataKey
    );
    if (
      operation.opId !== materialized.opId ||
      operation.repositoryId !== intent.repositoryId ||
      operation.entityType !== intent.entityType ||
      operation.entityId !== intent.entityId ||
      operation.kind !== intent.kind
    ) {
      throw new Error(
        `Materialized operation does not match intent: ${intent.intentId}`
      );
    }
    await this.applyLogicalMutation(
      { intent, logicalPayload: operation.payload, materialized },
      permit
    );
    return true;
  }

  async applyRemote(state: unknown, permit: AsyncMutexPermit) {
    if (
      state === null ||
      typeof state !== "object" ||
      !("entries" in state) ||
      !("order" in state)
    ) {
      throw new Error("Derived sync state is invalid");
    }
    await this.applyDerivedStateWithPermit(state as DerivedSyncState, permit);
  }

  async rewriteLocalEncryption(
    rewrite: () => Promise<void>,
    permit: AsyncMutexPermit
  ) {
    void permit;
    await rewrite();
  }

  async materializeIntent(
    intent: SyncMutationIntent,
    session: SyncRepositorySession
  ): Promise<MaterializedSyncIntent> {
    const { entries } = await this.getUnlockedEntries();
    let payload: unknown;
    if (intent.entityType === "order") {
      payload = { ids: entries.map((entry) => entry.hash) };
    } else if (intent.kind === "delete") {
      payload = null;
    } else {
      const entry = entries.find(
        (candidate) => candidate.hash === intent.entityId
      );
      if (!entry) {
        throw new DirtyIntentAccountMissingError(intent.intentId);
      }
      const logical = toLogicalPayload(entry);
      payload =
        intent.kind === "resolve"
          ? { resolution: "upsert", entry: logical }
          : logical;
    }
    const operation = await createOperation({
      formatVersion: 1,
      opId: crypto.randomUUID(),
      repositoryId: intent.repositoryId,
      deviceId: this.requireDeviceId(),
      entityType: intent.entityType,
      entityId: intent.entityId,
      kind: intent.kind,
      parents: [...intent.parents],
      createdAt: intent.createdAt,
      payload,
    });
    return {
      opId: operation.opId,
      envelope: await createOperationEnvelope(
        operation,
        session.mode,
        session.dataKey
      ),
    };
  }

  private requireDeviceId() {
    if (!this.deviceId) {
      throw new Error("Local sync device id is not configured");
    }
    return this.deviceId;
  }

  private async createSeedMutation(
    session: SyncRepositorySession,
    deviceId: string,
    entityType: "otp" | "order",
    entityId: string,
    payload: unknown
  ): Promise<AccountMutation> {
    const createdAt = Date.now();
    const intent: SyncMutationIntent = {
      intentId: crypto.randomUUID(),
      repositoryId: session.repositoryId,
      entityType,
      entityId,
      kind: "upsert",
      parents: [],
      createdAt,
      localApplied: false,
    };
    const operation = await createOperation({
      formatVersion: 1,
      opId: crypto.randomUUID(),
      repositoryId: session.repositoryId,
      deviceId,
      entityType,
      entityId,
      kind: "upsert",
      parents: [],
      createdAt,
      payload,
    });
    return {
      intent,
      logicalPayload: payload,
      materialized: {
        opId: operation.opId,
        envelope: await createOperationEnvelope(
          operation,
          session.mode,
          session.dataKey
        ),
      },
    };
  }

  async ensureSeeded(
    operations: SyncOperation[],
    session: SyncRepositorySession
  ) {
    const { entries } = await this.getUnlockedEntries();
    const local = entries.map((entry) => ({
      id: entry.hash,
      payload: toLogicalPayload(entry),
    }));
    const remote = deriveSyncState(operations, session.repositoryId);
    if (remote.pending.length > 0) {
      return true;
    }
    const remoteById = new Map(
      remote.entries.map((entry) => [entry.id, entry])
    );
    const seeds = local.filter((entry) => {
      const remoteEntry = remoteById.get(entry.id);
      return (
        !remoteEntry || !comparePayloads(entry.payload, remoteEntry.payload)
      );
    });
    const localOrder = local.map((entry) => entry.id);
    const hasOrderOperation = operations.some(
      (operation) =>
        operation.entityType === "order" &&
        operation.entityId === "global-order" &&
        operation.kind !== "delete"
    );
    const needsOrder =
      localOrder.length > 0 &&
      (!hasOrderOperation ||
        canonicalStringify(localOrder) !== canonicalStringify(remote.order));

    if (seeds.length === 0 && !needsOrder) {
      return true;
    }
    if (!this.seedWriter) {
      throw new Error("First-connect seed writer is not configured");
    }
    const deviceId = this.requireDeviceId();
    for (const seed of seeds) {
      await this.seedWriter.mutate(
        await this.createSeedMutation(
          session,
          deviceId,
          "otp",
          seed.id,
          seed.payload
        )
      );
    }
    if (needsOrder) {
      await this.seedWriter.mutate(
        await this.createSeedMutation(
          session,
          deviceId,
          "order",
          "global-order",
          { ids: localOrder }
        )
      );
    }
    return false;
  }

  applyDerivedState(
    state: DerivedSyncState,
    isCurrent: () => Promise<boolean>,
    afterApply: () => Promise<void>
  ) {
    return accountWriteMutex.runExclusive(async (permit) => {
      if (!(await isCurrent())) {
        return false;
      }
      await this.applyDerivedStateWithPermit(state, permit);
      await afterApply();
      return true;
    });
  }

  private async applyDerivedStateWithPermit(
    state: DerivedSyncState,
    permit?: AsyncMutexPermit
  ) {
    const encryption = await this.getEncryptionForWrite();
    const entries = state.entries.map((entry, index) =>
      createEntry(entry.id, index, entry.payload, encryption)
    );
    await this.storage.replace(entries, permit);
  }
}
