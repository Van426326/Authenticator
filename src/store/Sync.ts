import { StoredSyncStatus } from "../sync/SyncRuntime";

export interface SyncState {
  status: string;
  updatedAt: number;
  lastSuccessfulSyncAt?: number;
  configured: boolean;
}

export class Sync {
  async getModule() {
    const stored = await chrome.storage.local.get([
      "githubSyncStatus",
      "githubSyncConnection",
    ]);
    const status = stored.githubSyncStatus as StoredSyncStatus | undefined;
    return {
      state: {
        status: status?.status || "unconfigured",
        updatedAt: status?.updatedAt || 0,
        lastSuccessfulSyncAt: status?.lastSuccessfulSyncAt,
        configured: Boolean(stored.githubSyncConnection),
      } as SyncState,
      mutations: {
        setStatus(state: SyncState, value: StoredSyncStatus) {
          state.status = value.status;
          state.updatedAt = value.updatedAt;
          state.lastSuccessfulSyncAt = value.lastSuccessfulSyncAt;
        },
        setConfigured(state: SyncState, configured: boolean) {
          state.configured = configured;
        },
      },
      namespaced: true,
    };
  }
}
