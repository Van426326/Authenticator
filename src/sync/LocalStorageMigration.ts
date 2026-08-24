import { StorageLocation, UserSettings } from "../models/settings";
import { accountWriteMutex, AsyncMutex, AsyncMutexPermit } from "./AsyncMutex";
import { canonicalStringify } from "./OperationReducer";

const USER_SETTINGS_KEY = "UserSettings";

export interface AsyncStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface AccountStorageLocation {
  usesLocalStorage(): Promise<boolean>;
  setLocalStorage(): Promise<void>;
}

export interface AccountStoragePolicy {
  isSyncStorageForced(): Promise<boolean>;
}

export interface StorageMigrationResult {
  copiedKeys: string[];
}

export class ManagedSyncStorageError extends Error {
  constructor() {
    super("Managed policy forces chrome.storage.sync");
    this.name = "ManagedSyncStorageError";
  }
}

export class StorageMigrationConflictError extends Error {
  constructor(readonly conflictingKeys: string[]) {
    super(
      `Local storage contains different data for: ${conflictingKeys.join(", ")}`
    );
    this.name = "StorageMigrationConflictError";
  }
}

function sameValue(left: unknown, right: unknown) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function compareStrings(left: string, right: string) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export interface LocalAccountStorageMigrationOptions {
  syncStorage: AsyncStorageArea;
  localStorage: AsyncStorageArea;
  location: AccountStorageLocation;
  policy: AccountStoragePolicy;
  writeMutex?: AsyncMutex;
}

export class LocalAccountStorageMigration {
  private readonly syncStorage: AsyncStorageArea;
  private readonly localStorage: AsyncStorageArea;
  private readonly location: AccountStorageLocation;
  private readonly policy: AccountStoragePolicy;
  private readonly writeMutex: AsyncMutex;

  constructor(options: LocalAccountStorageMigrationOptions) {
    this.syncStorage = options.syncStorage;
    this.localStorage = options.localStorage;
    this.location = options.location;
    this.policy = options.policy;
    this.writeMutex = options.writeMutex || accountWriteMutex;
  }

  migrate(permit?: AsyncMutexPermit): Promise<StorageMigrationResult> {
    return this.writeMutex.runExclusive(() => this.migrateUnlocked(), permit);
  }

  private async migrateUnlocked(): Promise<StorageMigrationResult> {
    if (await this.policy.isSyncStorageForced()) {
      throw new ManagedSyncStorageError();
    }

    const usesLocalStorage = await this.location.usesLocalStorage();
    const [syncData, localData] = await Promise.all([
      this.syncStorage.get(null),
      this.localStorage.get(null),
    ]);
    const copiedKeys = Object.keys(syncData)
      .filter((key) => key !== USER_SETTINGS_KEY)
      .sort(compareStrings);
    const conflictingKeys = copiedKeys.filter(
      (key) =>
        !Object.prototype.hasOwnProperty.call(localData, key) ||
        !sameValue(syncData[key], localData[key])
    );

    if (usesLocalStorage) {
      if (conflictingKeys.length > 0) {
        throw new StorageMigrationConflictError(conflictingKeys);
      }
      if (copiedKeys.length > 0) {
        await this.syncStorage.remove(copiedKeys);
      }
      return { copiedKeys: [] };
    }

    const overwriteConflicts = conflictingKeys.filter((key) =>
      Object.prototype.hasOwnProperty.call(localData, key)
    );
    if (overwriteConflicts.length > 0) {
      throw new StorageMigrationConflictError(overwriteConflicts);
    }

    if (copiedKeys.length > 0) {
      const accountData = Object.fromEntries(
        copiedKeys.map((key) => [key, syncData[key]])
      );
      await this.localStorage.set(accountData);

      const persisted = await this.localStorage.get(copiedKeys);
      const invalidKeys = copiedKeys.filter(
        (key) =>
          !Object.prototype.hasOwnProperty.call(persisted, key) ||
          !sameValue(syncData[key], persisted[key])
      );
      if (invalidKeys.length > 0) {
        throw new Error(
          `Unable to verify local account data: ${invalidKeys.join(", ")}`
        );
      }
    }

    await this.location.setLocalStorage();
    if (copiedKeys.length > 0) {
      await this.syncStorage.remove(copiedKeys);
    }

    return { copiedKeys };
  }
}

function getManagedStorageLocation() {
  return new Promise<StorageLocation | undefined>((resolve) => {
    if (!chrome.storage.managed) {
      resolve(undefined);
      return;
    }
    const timeout = setTimeout(() => resolve(undefined), 10);
    chrome.storage.managed.get("storageArea", (data) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      const location = data?.storageArea;
      resolve(
        location === StorageLocation.Local || location === StorageLocation.Sync
          ? location
          : undefined
      );
    });
  });
}

function browserStorageArea(
  area: typeof chrome.storage.local
): AsyncStorageArea {
  return {
    async get(keys) {
      return area.get(keys) as Promise<Record<string, unknown>>;
    },
    async set(items) {
      await area.set(items);
    },
    async remove(keys) {
      await area.remove(keys);
    },
  };
}

export async function forceAccountStorageLocal() {
  const location: AccountStorageLocation = {
    async usesLocalStorage() {
      await UserSettings.updateItems();
      return UserSettings.items.storageLocation === StorageLocation.Local;
    },
    async setLocalStorage() {
      UserSettings.items.storageLocation = StorageLocation.Local;
      await UserSettings.commitItems();
    },
  };
  const policy: AccountStoragePolicy = {
    async isSyncStorageForced() {
      return (await getManagedStorageLocation()) === StorageLocation.Sync;
    },
  };

  return new LocalAccountStorageMigration({
    syncStorage: browserStorageArea(chrome.storage.sync),
    localStorage: browserStorageArea(chrome.storage.local),
    location,
    policy,
  }).migrate();
}
