import {
  canonicalStringify,
  ReducedEntity,
  reduceOperations,
  SyncOperation,
} from "./OperationReducer";

export type LogicalOtpType =
  | "totp"
  | "hotp"
  | "battle"
  | "steam"
  | "hex"
  | "hhex";

export interface LogicalOtpPayload {
  type: LogicalOtpType;
  secret: string;
  issuer?: string;
  account?: string;
  counter?: number;
  period?: number;
  digits?: number;
  algorithm?: string;
  pinned?: boolean;
}

export interface DerivedOtpEntry {
  id: string;
  payload: LogicalOtpPayload;
  source: SyncOperation;
  conflicts: SyncOperation[];
}

export interface DerivedSyncState {
  entries: DerivedOtpEntry[];
  order: string[];
  conflicts: ReducedEntity[];
  pending: SyncOperation[];
}

function compareStrings(left: string, right: string) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function unwrapPayload(operation: SyncOperation): unknown {
  if (
    operation.kind === "resolve" &&
    operation.payload !== null &&
    typeof operation.payload === "object" &&
    "resolution" in operation.payload &&
    operation.payload.resolution === "upsert" &&
    "entry" in operation.payload
  ) {
    return operation.payload.entry;
  }
  return operation.payload;
}

function isLogicalOtpPayload(payload: unknown): payload is LogicalOtpPayload {
  if (payload === null || typeof payload !== "object") {
    return false;
  }
  if (!("type" in payload) || !("secret" in payload)) {
    return false;
  }
  const hasValidCounter =
    !("counter" in payload) ||
    (typeof payload.counter === "number" &&
      Number.isInteger(payload.counter) &&
      payload.counter >= 0);
  return (
    typeof payload.type === "string" &&
    ["totp", "hotp", "battle", "steam", "hex", "hhex"].includes(payload.type) &&
    typeof payload.secret === "string" &&
    hasValidCounter
  );
}

function getOtpPayload(operation: SyncOperation): LogicalOtpPayload {
  const payload = unwrapPayload(operation);
  if (!isLogicalOtpPayload(payload)) {
    throw new Error(`Operation has an invalid OTP payload: ${operation.opId}`);
  }
  return payload;
}

function withoutCounter(payload: LogicalOtpPayload) {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "counter") {
      copy[key] = value;
    }
  }
  return copy;
}

function isCounterBased(payload: LogicalOtpPayload) {
  return payload.type === "hotp" || payload.type === "hhex";
}

function getUpsertHeads(entity: ReducedEntity) {
  return entity.heads.filter((operation) => !isDeleteOperation(operation));
}

function getApplicableUpserts(
  entity: ReducedEntity,
  operations: SyncOperation[],
  pendingIds: Set<string>
) {
  return operations.filter(
    (operation) =>
      operation.entityType === entity.entityType &&
      operation.entityId === entity.entityId &&
      !pendingIds.has(operation.opId) &&
      !isDeleteOperation(operation)
  );
}

function isDeleteOperation(operation: SyncOperation) {
  if (operation.kind === "delete") {
    return true;
  }
  return Boolean(
    operation.kind === "resolve" &&
      operation.payload !== null &&
      typeof operation.payload === "object" &&
      "resolution" in operation.payload &&
      operation.payload.resolution === "delete"
  );
}

function deriveOtpEntry(
  entity: ReducedEntity,
  operations: SyncOperation[],
  pendingIds: Set<string>
): DerivedOtpEntry | null {
  if (entity.deleted) {
    return null;
  }

  const primaryPayload = getOtpPayload(entity.primary);
  if (!isCounterBased(primaryPayload)) {
    return {
      id: entity.entityId,
      payload: primaryPayload,
      source: entity.primary,
      conflicts: entity.conflicts,
    };
  }

  const upsertHeads = getUpsertHeads(entity);
  const applicablePayloads = getApplicableUpserts(
    entity,
    operations,
    pendingIds
  ).map(getOtpPayload);
  const maxCounter = applicablePayloads.reduce(
    (current, payload) => Math.max(current, payload.counter || 0),
    0
  );
  const primaryShape = canonicalStringify(withoutCounter(primaryPayload));
  const conflicts = upsertHeads.filter((operation) => {
    if (operation.opId === entity.primary.opId) {
      return false;
    }
    return (
      canonicalStringify(withoutCounter(getOtpPayload(operation))) !==
      primaryShape
    );
  });

  return {
    id: entity.entityId,
    payload: { ...primaryPayload, counter: maxCounter },
    source: entity.primary,
    conflicts,
  };
}

function getOrderIds(orderEntity: ReducedEntity | undefined) {
  if (!orderEntity || orderEntity.deleted) {
    return [];
  }
  const payload = unwrapPayload(orderEntity.primary);
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("ids" in payload) ||
    !Array.isArray(payload.ids) ||
    !payload.ids.every((id) => typeof id === "string")
  ) {
    throw new Error(`Order operation has an invalid payload`);
  }
  return payload.ids as string[];
}

function getFirstOperationIds(operations: SyncOperation[]) {
  const firstIds = new Map<string, string>();
  for (const operation of operations) {
    if (
      operation.entityType !== "otp" ||
      operation.kind !== "upsert" ||
      operation.parents.length !== 0
    ) {
      continue;
    }
    const current = firstIds.get(operation.entityId);
    if (!current || compareStrings(operation.opId, current) < 0) {
      firstIds.set(operation.entityId, operation.opId);
    }
  }
  return firstIds;
}

function deriveOrder(
  requestedIds: string[],
  entries: DerivedOtpEntry[],
  operations: SyncOperation[]
) {
  const activeIds = new Set(entries.map((entry) => entry.id));
  const seenIds = new Set<string>();
  const order = requestedIds.filter((id) => {
    if (!activeIds.has(id) || seenIds.has(id)) {
      return false;
    }
    seenIds.add(id);
    return true;
  });
  const firstOperationIds = getFirstOperationIds(operations);
  const missingIds = Array.from(activeIds)
    .filter((id) => !seenIds.has(id))
    .sort((left, right) => {
      const leftRoot = firstOperationIds.get(left) || left;
      const rightRoot = firstOperationIds.get(right) || right;
      return compareStrings(leftRoot, rightRoot) || compareStrings(left, right);
    });
  return order.concat(missingIds);
}

export function deriveSyncState(
  operations: SyncOperation[],
  repositoryId: string
): DerivedSyncState {
  const reduced = reduceOperations(operations, repositoryId);
  const pendingIds = new Set(
    reduced.pending.map((operation) => operation.opId)
  );
  const entries = reduced.entities.flatMap((entity) => {
    if (entity.entityType !== "otp") {
      return [];
    }
    const entry = deriveOtpEntry(entity, operations, pendingIds);
    return entry ? [entry] : [];
  });
  const orderEntity = reduced.entities.find(
    (entity) =>
      entity.entityType === "order" && entity.entityId === "global-order"
  );
  const order = deriveOrder(getOrderIds(orderEntity), entries, operations);
  const positions = new Map(order.map((id, index) => [id, index]));
  entries.sort(
    (left, right) =>
      (positions.get(left.id) as number) - (positions.get(right.id) as number)
  );

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const conflicts = reduced.entities
    .map((entity) => {
      const derivedEntry = entriesById.get(entity.entityId);
      return derivedEntry
        ? { ...entity, conflicts: derivedEntry.conflicts }
        : entity;
    })
    .filter((entity) => entity.conflicts.length > 0);

  return { entries, order, conflicts, pending: reduced.pending };
}
