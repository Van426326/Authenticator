import "mocha";
import { assert } from "chai";

import {
  AccountMutation,
  LocalAccountAdapter,
  SyncCoordinator,
  SyncJournalPort,
  SyncScheduler,
} from "../../sync/SyncCoordinator";
import { OutboxOperation, SyncMutationIntent } from "../../sync/SyncJournal";

mocha.setup("bdd");

function intent(intentId: string): SyncMutationIntent {
  return {
    intentId,
    repositoryId: "repository-1",
    entityType: "otp",
    entityId: intentId,
    kind: "upsert",
    parents: [],
    createdAt: 1,
    localApplied: false,
  };
}

class FakeJournal implements SyncJournalPort {
  events: string[] = [];
  headEvents: string[] = [];
  intents = new Map<string, SyncMutationIntent>();

  constructor(private readonly timeline: string[] = []) {}

  private record(event: string) {
    this.events.push(event);
    this.timeline.push(event);
  }

  async enqueueIntent(value: SyncMutationIntent) {
    this.record(`journal:${value.intentId}`);
    if (!this.intents.has(value.intentId)) {
      this.intents.set(value.intentId, value);
    }
  }

  async getIntent(intentId: string) {
    return this.intents.get(intentId);
  }

  async listIntents(repositoryId: string) {
    return Array.from(this.intents.values()).filter(
      (value) => value.repositoryId === repositoryId,
    );
  }

  async getOperationForIntent() {
    return undefined;
  }

  async materializeIntent(intentId: string, opId: string, envelope: string) {
    this.record(`envelope:${intentId}:${opId}:${envelope}`);
    return {
      opId,
      intentId,
      repositoryId: "repository-1",
      envelope,
      remoteAcknowledged: false,
    } as OutboxOperation;
  }

  async advanceEntityHeads(value: SyncMutationIntent, opId: string) {
    this.headEvents.push(`${value.intentId}:${opId}`);
  }

  async markIntentApplied(intentId: string) {
    this.record(`applied:${intentId}`);
    const value = this.intents.get(intentId);
    if (value) {
      this.intents.set(intentId, { ...value, localApplied: true });
    }
  }
}

class FakeAdapter implements LocalAccountAdapter {
  events: string[] = [];
  activeWrites = 0;
  maxActiveWrites = 0;

  constructor(private readonly timeline: string[] = []) {}

  private record(event: string) {
    this.events.push(event);
    this.timeline.push(event);
  }

  async applyMutation(mutation: AccountMutation) {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    this.record(`local:${mutation.intent.intentId}`);
    await Promise.resolve();
    this.activeWrites -= 1;
  }

  async recoverIntent(value: SyncMutationIntent) {
    this.record(`recover:${value.intentId}`);
    return true;
  }

  async applyRemote() {
    this.record("remote");
  }

  async rewriteLocalEncryption() {
    this.record("reencrypt");
  }
}

class FakeScheduler implements SyncScheduler {
  events: string[] = [];

  constructor(private readonly timeline: string[] = []) {}

  private record(event: string) {
    this.events.push(event);
    this.timeline.push(event);
  }

  async markPending(repositoryId: string) {
    this.record(`pending:${repositoryId}`);
  }

  schedule(delayMs: number) {
    this.record(`schedule:${delayMs}`);
  }
}

describe("SyncCoordinator", () => {
  it("commits journal and immutable envelope before applying locally", async () => {
    const timeline: string[] = [];
    const journal = new FakeJournal(timeline);
    const adapter = new FakeAdapter(timeline);
    const scheduler = new FakeScheduler(timeline);
    const coordinator = new SyncCoordinator(journal, adapter, scheduler);

    await coordinator.mutate({
      intent: intent("intent-1"),
      logicalPayload: { secret: "secret" },
      materialized: { opId: "operation-1", envelope: "fixed-envelope" },
    });

    assert.deepEqual(journal.events, [
      "journal:intent-1",
      "envelope:intent-1:operation-1:fixed-envelope",
      "applied:intent-1",
    ]);
    assert.deepEqual(adapter.events, ["local:intent-1"]);
    assert.deepEqual(journal.headEvents, ["intent-1:operation-1"]);
    assert.deepEqual(scheduler.events, [
      "pending:repository-1",
      "schedule:5000",
    ]);
    assert.deepEqual(timeline, [
      "journal:intent-1",
      "envelope:intent-1:operation-1:fixed-envelope",
      "local:intent-1",
      "applied:intent-1",
      "pending:repository-1",
      "schedule:5000",
    ]);
  });

  it("serializes concurrent local writes", async () => {
    const journal = new FakeJournal();
    const adapter = new FakeAdapter();
    const coordinator = new SyncCoordinator(
      journal,
      adapter,
      new FakeScheduler(),
    );

    await Promise.all([
      coordinator.mutate({
        intent: intent("intent-1"),
        logicalPayload: { secret: "first" },
      }),
      coordinator.mutate({
        intent: intent("intent-2"),
        logicalPayload: { secret: "second" },
      }),
    ]);

    assert.equal(adapter.maxActiveWrites, 1);
  });

  it("does not reapply an intent that is already locally applied", async () => {
    const journal = new FakeJournal();
    const adapter = new FakeAdapter();
    const coordinator = new SyncCoordinator(
      journal,
      adapter,
      new FakeScheduler(),
    );
    const mutation: AccountMutation = {
      intent: intent("intent-1"),
      logicalPayload: { secret: "secret" },
    };

    await coordinator.mutate(mutation);
    await coordinator.mutate(mutation);

    assert.deepEqual(adapter.events, ["local:intent-1"]);
  });

  it("recovers unapplied intents and marks them pending", async () => {
    const timeline: string[] = [];
    const journal = new FakeJournal(timeline);
    const adapter = new FakeAdapter(timeline);
    const scheduler = new FakeScheduler(timeline);
    const coordinator = new SyncCoordinator(journal, adapter, scheduler);
    await journal.enqueueIntent(intent("intent-1"));
    timeline.length = 0;

    await coordinator.recoverPending("repository-1");

    assert.deepEqual(timeline, [
      "recover:intent-1",
      "applied:intent-1",
      "pending:repository-1",
      "schedule:5000",
    ]);
  });

  it("does not schedule a recovery run when there is nothing to recover", async () => {
    const scheduler = new FakeScheduler();
    const coordinator = new SyncCoordinator(
      new FakeJournal(),
      new FakeAdapter(),
      scheduler,
    );

    await coordinator.recoverPending("repository-1");

    assert.deepEqual(scheduler.events, []);
  });

  it("does not mark a failed local mutation as applied or pending", async () => {
    const journal = new FakeJournal();
    const scheduler = new FakeScheduler();
    const adapter: LocalAccountAdapter = {
      async applyMutation() {
        throw new Error("write failed");
      },
      async recoverIntent() {
        return false;
      },
      async applyRemote() {},
      async rewriteLocalEncryption() {},
    };
    const coordinator = new SyncCoordinator(journal, adapter, scheduler);

    let rejected = false;
    try {
      await coordinator.mutate({
        intent: intent("intent-1"),
        logicalPayload: { secret: "secret" },
      });
    } catch {
      rejected = true;
    }

    assert.isTrue(rejected);
    assert.deepEqual(journal.events, ["journal:intent-1"]);
    assert.deepEqual(scheduler.events, []);
  });

  it("applies remote and local-encryption writes without emitting operations", async () => {
    const journal = new FakeJournal();
    const adapter = new FakeAdapter();
    const coordinator = new SyncCoordinator(
      journal,
      adapter,
      new FakeScheduler(),
    );

    await coordinator.applyRemote({ entries: [] });
    await coordinator.rewriteLocalEncryption(async () => undefined);

    assert.deepEqual(adapter.events, ["remote", "reencrypt"]);
    assert.deepEqual(journal.events, []);
  });
});
