import "mocha";
import { assert } from "chai";

import {
  BackgroundSyncTriggers,
  SyncRunController,
  SyncRunResult,
  SyncStatusReporter,
  SyncTriggerReason,
} from "../../sync/SyncRunController";

mocha.setup("bdd");

class FakeReporter implements SyncStatusReporter {
  statuses: string[] = [];

  async setStatus(status: string) {
    this.statuses.push(status);
  }
}

function deferred() {
  let resolve!: (value: SyncRunResult) => void;
  const promise = new Promise<SyncRunResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SyncRunController", () => {
  it("coalesces overlapping requests into one follow-up run", async () => {
    const reporter = new FakeReporter();
    const first = deferred();
    let runs = 0;
    const controller = new SyncRunController(
      {
        run() {
          runs += 1;
          return runs === 1
            ? first.promise
            : Promise.resolve({ status: "synced" as const });
        },
      },
      reporter,
    );

    const active = controller.request("popup");
    const overlapping = controller.request("manual");
    assert.equal(active, overlapping);
    first.resolve({ status: "pending" });
    await active;

    assert.equal(runs, 2);
    assert.deepEqual(reporter.statuses, [
      "syncing",
      "pending",
      "syncing",
      "synced",
    ]);
  });

  it("invalidates an in-flight result before destructive connection cleanup", async () => {
    const reporter = new FakeReporter();
    const first = deferred();
    let runs = 0;
    const controller = new SyncRunController(
      {
        run() {
          runs += 1;
          return runs === 1
            ? first.promise
            : Promise.resolve({ status: "synced" as const });
        },
      },
      reporter,
    );

    const active = controller.request("manual");
    await Promise.resolve();
    controller.invalidate();
    first.resolve({ status: "synced" });
    await active;

    assert.deepEqual(reporter.statuses, ["syncing"]);
    await controller.request("manual");
    assert.deepEqual(reporter.statuses, ["syncing", "syncing", "synced"]);
  });

  it("reports failures and allows a later retry", async () => {
    const reporter = new FakeReporter();
    let runs = 0;
    const controller = new SyncRunController(
      {
        async run() {
          runs += 1;
          if (runs === 1) {
            throw new Error("offline");
          }
          return { status: "synced" };
        },
      },
      reporter,
    );

    let rejected = false;
    try {
      await controller.request("alarm");
    } catch {
      rejected = true;
    }
    await controller.request("manual");

    assert.isTrue(rejected);
    assert.deepEqual(reporter.statuses, [
      "syncing",
      "error",
      "syncing",
      "synced",
    ]);
  });
});

describe("BackgroundSyncTriggers", () => {
  it("debounces local changes for five seconds", async () => {
    const delays: number[] = [];
    const callbacks: Array<() => void> = [];
    let requests = 0;
    const triggers = new BackgroundSyncTriggers(
      {
        async request() {
          requests += 1;
        },
      },
      {
        set(handler: () => void, delayMs: number) {
          delays.push(delayMs);
          callbacks.push(handler);
          return callbacks.length;
        },
        clear() {},
      },
    );

    triggers.localChange();
    triggers.localChange();
    triggers.localChange();
    callbacks[callbacks.length - 1]();
    await Promise.resolve();

    assert.deepEqual(delays, [5000, 5000, 5000]);
    assert.equal(requests, 1);
  });

  it("runs popup/manual/alarm triggers immediately and cancels debounce", async () => {
    const cleared: unknown[] = [];
    const reasons: string[] = [];
    const triggers = new BackgroundSyncTriggers(
      {
        async request(reason: SyncTriggerReason) {
          reasons.push(reason);
        },
      },
      {
        set() {
          return "timer";
        },
        clear(timer: unknown) {
          cleared.push(timer);
        },
      },
    );

    triggers.localChange();
    await triggers.immediate("popup");
    await triggers.immediate("manual");
    await triggers.immediate("alarm");

    assert.deepEqual(cleared, ["timer"]);
    assert.deepEqual(reasons, ["popup", "manual", "alarm"]);
  });
});
