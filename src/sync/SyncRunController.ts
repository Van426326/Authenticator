export type SyncTriggerReason = "local" | "popup" | "manual" | "alarm";

export type SyncStatus =
  | "unconfigured"
  | "testing"
  | "initializing"
  | "synced"
  | "pending"
  | "syncing"
  | "conflict"
  | "needsSyncPassword"
  | "needsLocalUnlock"
  | "permissionRequired"
  | "tokenRequired"
  | "authFailed"
  | "rateLimited"
  | "branchProtected"
  | "repositoryChanged"
  | "historyRewritten"
  | "offline"
  | "unsupportedServer"
  | "remoteMissing"
  | "remoteIncomplete"
  | "remoteCorrupt"
  | "error";

export interface SyncRunResult {
  status: Exclude<SyncStatus, "syncing">;
}

export interface SyncRunner {
  run(reasons: SyncTriggerReason[]): Promise<SyncRunResult>;
}

export interface SyncStatusReporter {
  setStatus(status: SyncStatus): Promise<void>;
}

export interface SyncRequestTarget {
  request(reason: SyncTriggerReason): Promise<void>;
}

export type SyncErrorClassifier = (
  error: unknown
) => Exclude<SyncStatus, "syncing">;

export class SyncRunController implements SyncRequestTarget {
  private activeRun?: Promise<void>;
  private runAgain = false;
  private generation = 0;
  private readonly pendingReasons = new Set<SyncTriggerReason>();

  constructor(
    private readonly runner: SyncRunner,
    private readonly reporter: SyncStatusReporter,
    private readonly classifyError: SyncErrorClassifier = () => "error"
  ) {}

  /**
   * Discards pending triggers and prevents an already-running pass from
   * publishing a stale final status after disconnect/forget cleanup.
   */
  invalidate() {
    this.generation += 1;
    this.pendingReasons.clear();
    this.runAgain = false;
  }

  request(reason: SyncTriggerReason) {
    this.pendingReasons.add(reason);
    if (this.activeRun) {
      this.runAgain = true;
      return this.activeRun;
    }

    const run = this.runLoop();
    this.activeRun = run;
    const clear = () => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    };
    run.then(clear, clear);
    return run;
  }

  private async runLoop() {
    while (this.pendingReasons.size > 0 || this.runAgain) {
      const reasons = Array.from(this.pendingReasons);
      const generation = this.generation;
      this.pendingReasons.clear();
      this.runAgain = false;
      await this.reporter.setStatus("syncing");
      try {
        const result = await this.runner.run(reasons);
        if (generation === this.generation) {
          await this.reporter.setStatus(result.status);
        }
      } catch (error) {
        if (generation !== this.generation) {
          continue;
        }
        await this.reporter.setStatus(this.classifyError(error));
        if (!this.runAgain && this.pendingReasons.size === 0) {
          throw error;
        }
      }
    }
  }
}

export interface SyncTimer {
  set(handler: () => void, delayMs: number): unknown;
  clear(timer: unknown): void;
}

const browserTimer: SyncTimer = {
  set(handler, delayMs) {
    return setTimeout(handler, delayMs);
  },
  clear(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export class BackgroundSyncTriggers {
  private debounceTimer?: unknown;

  constructor(
    private readonly target: SyncRequestTarget,
    private readonly timer: SyncTimer = browserTimer
  ) {}

  localChange() {
    this.cancelDebounce();
    const timer = this.timer.set(() => {
      if (this.debounceTimer !== timer) {
        return;
      }
      this.debounceTimer = undefined;
      void this.target.request("local").catch(() => undefined);
    }, 5000);
    this.debounceTimer = timer;
  }

  immediate(reason: Exclude<SyncTriggerReason, "local">) {
    this.cancelDebounce();
    return this.target.request(reason);
  }

  cancelDebounce() {
    if (this.debounceTimer !== undefined) {
      this.timer.clear(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
