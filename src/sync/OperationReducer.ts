export type SyncEntityType = "otp" | "order";
export type SyncOperationKind = "upsert" | "delete" | "resolve";

export interface SyncOperation {
  formatVersion: 1;
  repositoryId: string;
  opId: string;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  kind: SyncOperationKind;
  parents: string[];
  createdAt: number;
  contentHash: string;
  payload: unknown;
}

export interface ReducedEntity {
  entityType: SyncEntityType;
  entityId: string;
  heads: SyncOperation[];
  primary: SyncOperation;
  conflicts: SyncOperation[];
  deleted: boolean;
}

export interface ReduceResult {
  entities: ReducedEntity[];
  pending: SyncOperation[];
}

function operationKey(operation: SyncOperation) {
  return `${operation.entityType}:${operation.entityId}`;
}

function compareStrings(left: string, right: string) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareOperations(left: SyncOperation, right: SyncOperation) {
  return compareStrings(left.opId, right.opId);
}

function compareEntities(left: ReducedEntity, right: ReducedEntity) {
  const typeOrder = compareStrings(left.entityType, right.entityType);
  return typeOrder || compareStrings(left.entityId, right.entityId);
}

function isDeleteResult(operation: SyncOperation) {
  if (operation.kind === "delete") {
    return true;
  }

  if (
    operation.kind === "resolve" &&
    operation.payload !== null &&
    typeof operation.payload === "object" &&
    "resolution" in operation.payload
  ) {
    return operation.payload.resolution === "delete";
  }

  return false;
}

function getLogicalResult(operation: SyncOperation): unknown {
  if (isDeleteResult(operation)) {
    return { resolution: "delete" };
  }
  if (
    operation.kind === "resolve" &&
    operation.payload !== null &&
    typeof operation.payload === "object" &&
    "entry" in operation.payload
  ) {
    return operation.payload.entry;
  }
  return operation.payload;
}

function hasSameLogicalResult(left: SyncOperation, right: SyncOperation) {
  return (
    isDeleteResult(left) === isDeleteResult(right) &&
    canonicalStringify(getLogicalResult(left)) ===
      canonicalStringify(getLogicalResult(right))
  );
}

function assertProtocol(operation: SyncOperation, repositoryId: string) {
  if (operation.formatVersion !== 1) {
    throw new Error(`Unsupported operation format: ${operation.opId}`);
  }
  if (operation.repositoryId !== repositoryId) {
    throw new Error(
      `Operation belongs to another repository: ${operation.opId}`
    );
  }
}

function assertIdentity(operation: SyncOperation) {
  if (!operation.opId || !operation.deviceId || !operation.entityId) {
    throw new Error("Operation identity fields must not be empty");
  }
  if (operation.parents.includes(operation.opId)) {
    throw new Error(`Operation cannot be its own parent: ${operation.opId}`);
  }
}

function assertDiscriminants(operation: SyncOperation) {
  if (operation.entityType !== "otp" && operation.entityType !== "order") {
    throw new Error(`Unsupported entity type: ${operation.opId}`);
  }
  if (
    operation.kind !== "upsert" &&
    operation.kind !== "delete" &&
    operation.kind !== "resolve"
  ) {
    throw new Error(`Unsupported operation kind: ${operation.opId}`);
  }
}

function assertMetadata(operation: SyncOperation) {
  if (!Number.isFinite(operation.createdAt)) {
    throw new Error(`Invalid operation timestamp: ${operation.opId}`);
  }
  if (!operation.contentHash) {
    throw new Error(
      `Operation content hash must not be empty: ${operation.opId}`
    );
  }
  if (new Set(operation.parents).size !== operation.parents.length) {
    throw new Error(`Operation has duplicate parents: ${operation.opId}`);
  }
}

function assertOperationShape(operation: SyncOperation, repositoryId: string) {
  assertProtocol(operation, repositoryId);
  assertIdentity(operation);
  assertDiscriminants(operation);
  assertMetadata(operation);
}

function deduplicateOperations(
  operations: SyncOperation[],
  repositoryId: string
) {
  const byId = new Map<string, SyncOperation>();
  const fingerprints = new Map<string, string>();

  for (const operation of operations) {
    assertOperationShape(operation, repositoryId);
    const fingerprint = canonicalStringify(operation);
    const existingFingerprint = fingerprints.get(operation.opId);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new Error(
        `Operation id has conflicting content: ${operation.opId}`
      );
    }
    if (!existingFingerprint) {
      byId.set(operation.opId, operation);
      fingerprints.set(operation.opId, fingerprint);
    }
  }

  return byId;
}

function assertParentIntegrity(byId: Map<string, SyncOperation>) {
  for (const operation of byId.values()) {
    for (const parentId of operation.parents) {
      const parent = byId.get(parentId);
      if (parent && operationKey(parent) !== operationKey(operation)) {
        throw new Error(
          `Operation parent belongs to another entity: ${operation.opId}`
        );
      }
    }
  }
}

function findPendingIds(byId: Map<string, SyncOperation>) {
  const pendingIds = new Set<string>();
  for (const operation of byId.values()) {
    if (operation.parents.some((parentId) => !byId.has(parentId))) {
      pendingIds.add(operation.opId);
    }
  }

  let pendingCount = -1;
  while (pendingCount !== pendingIds.size) {
    pendingCount = pendingIds.size;
    for (const operation of byId.values()) {
      const hasPendingParent = operation.parents.some((parentId) =>
        pendingIds.has(parentId)
      );
      if (hasPendingParent) {
        pendingIds.add(operation.opId);
      }
    }
  }

  return pendingIds;
}

function assertAcyclic(
  operations: SyncOperation[],
  byId: Map<string, SyncOperation>
) {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (operation: SyncOperation) => {
    if (visiting.has(operation.opId)) {
      throw new Error(`Operation graph contains a cycle: ${operation.opId}`);
    }
    if (visited.has(operation.opId)) {
      return;
    }

    visiting.add(operation.opId);
    for (const parentId of operation.parents) {
      const parent = byId.get(parentId);
      if (parent) {
        visit(parent);
      }
    }
    visiting.delete(operation.opId);
    visited.add(operation.opId);
  };

  for (const operation of operations) {
    visit(operation);
  }
}

function groupOperations(operations: SyncOperation[]) {
  const groups = new Map<string, SyncOperation[]>();
  for (const operation of operations) {
    const key = operationKey(operation);
    const group = groups.get(key) || [];
    group.push(operation);
    groups.set(key, group);
  }
  return groups;
}

function reduceEntity(group: SyncOperation[]): ReducedEntity {
  const referencedParents = new Set(
    group.flatMap((operation) => operation.parents)
  );
  const heads = group
    .filter((operation) => !referencedParents.has(operation.opId))
    .sort(compareOperations);
  if (heads.length === 0) {
    throw new Error(`Operation graph has no head: ${operationKey(group[0])}`);
  }

  const primary =
    heads.filter(isDeleteResult).sort(compareOperations)[0] || heads[0];
  const conflicts = heads.filter(
    (operation) =>
      operation.opId !== primary.opId &&
      !hasSameLogicalResult(operation, primary)
  );

  return {
    entityType: primary.entityType,
    entityId: primary.entityId,
    heads,
    primary,
    conflicts,
    deleted: isDeleteResult(primary),
  };
}

export function reduceOperations(
  operations: SyncOperation[],
  repositoryId: string
): ReduceResult {
  const byId = deduplicateOperations(operations, repositoryId);
  assertParentIntegrity(byId);
  const pendingIds = findPendingIds(byId);
  const applicable = Array.from(byId.values()).filter(
    (operation) => !pendingIds.has(operation.opId)
  );
  assertAcyclic(applicable, byId);

  const entities = Array.from(groupOperations(applicable).values())
    .map(reduceEntity)
    .sort(compareEntities);
  const pending = Array.from(pendingIds)
    .map((opId) => byId.get(opId) as SyncOperation)
    .sort(compareOperations);

  return { entities, pending };
}

export function canonicalStringify(value: unknown): string {
  const seen = new Set<object>();

  const serialize = (item: unknown): string => {
    if (item === null) {
      return "null";
    }
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("Canonical JSON does not support non-finite numbers");
      }
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) {
        throw new Error("Canonical JSON does not support cyclic values");
      }
      seen.add(item);
      const result = `[${item.map((entry) => serialize(entry)).join(",")}]`;
      seen.delete(item);
      return result;
    }
    if (typeof item === "object") {
      if (seen.has(item)) {
        throw new Error("Canonical JSON does not support cyclic values");
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Canonical JSON supports plain objects only");
      }

      seen.add(item);
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareStrings);
      const result = `{${keys
        .map((key) => {
          if (record[key] === undefined) {
            throw new Error("Canonical JSON does not support undefined values");
          }
          return `${JSON.stringify(key)}:${serialize(record[key])}`;
        })
        .join(",")}}`;
      seen.delete(item);
      return result;
    }

    throw new Error(`Canonical JSON does not support ${typeof item}`);
  };

  return serialize(value);
}
