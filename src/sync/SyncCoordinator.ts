import { accountWriteMutex, AsyncMutex, AsyncMutexPermit } from "./AsyncMutex";
import { OutboxOperation, SyncMutationIntent } from "./SyncJournal";

export interface MaterializedMutation {
  opId: string;
  envelope: string;
  /** Present on newly materialized operations; absent only on legacy records. */
  deviceId?: string;
}

export interface AccountMutation {
  intent: SyncMutationIntent;
  logicalPayload?: unknown;
  materialized?: MaterializedMutation;
}

export interface SyncJournalPort {
  enqueueIntent(intent: SyncMutationIntent): Promise<void>;
  getIntent(intentId: string): Promise<SyncMutationIntent | undefined>;
  listIntents(repositoryId: string): Promise<SyncMutationIntent[]>;
  getOperationForIntent(intentId: string): Promise<OutboxOperation | undefined>;
  materializeIntent(
    intentId: string,
    opId: string,
    envelope: string,
    deviceId?: string
  ): Promise<OutboxOperation>;
  markIntentApplied(intentId: string): Promise<void>;
  advanceEntityHeads(intent: SyncMutationIntent, opId: string): Promise<void>;
}

export interface LocalAccountAdapter {
  applyMutation(
    mutation: AccountMutation,
    permit: AsyncMutexPermit
  ): Promise<void>;
  recoverIntent(
    intent: SyncMutationIntent,
    materialized: MaterializedMutation | undefined,
    permit: AsyncMutexPermit
  ): Promise<boolean>;
  applyRemote(state: unknown, permit: AsyncMutexPermit): Promise<void>;
  rewriteLocalEncryption(
    rewrite: () => Promise<void>,
    permit: AsyncMutexPermit
  ): Promise<void>;
}

export interface SyncScheduler {
  markPending(repositoryId: string): Promise<void>;
  schedule(delayMs: number): void;
}

export class SyncCoordinator {
  constructor(
    private readonly journal: SyncJournalPort,
    private readonly localAccounts: LocalAccountAdapter,
    private readonly scheduler: SyncScheduler,
    private readonly writeMutex: AsyncMutex = accountWriteMutex
  ) {}

  private runExclusive<T>(
    operation: (permit: AsyncMutexPermit) => Promise<T>,
    permit?: AsyncMutexPermit
  ): Promise<T> {
    return this.writeMutex.runExclusive(operation, permit);
  }

  mutate(mutation: AccountMutation, existingPermit?: AsyncMutexPermit) {
    return this.runExclusive(async (permit) => {
      await this.journal.enqueueIntent(mutation.intent);
      const storedIntent = await this.journal.getIntent(
        mutation.intent.intentId
      );
      if (storedIntent?.localApplied) {
        return;
      }
      if (mutation.materialized) {
        await this.journal.materializeIntent(
          mutation.intent.intentId,
          mutation.materialized.opId,
          mutation.materialized.envelope,
          mutation.materialized.deviceId
        );
      }
      await this.localAccounts.applyMutation(mutation, permit);
      if (mutation.materialized) {
        await this.journal.advanceEntityHeads(
          mutation.intent,
          mutation.materialized.opId
        );
      }
      await this.journal.markIntentApplied(mutation.intent.intentId);
      await this.scheduler.markPending(mutation.intent.repositoryId);
      this.scheduler.schedule(5000);
    }, existingPermit);
  }

  recoverPending(repositoryId: string) {
    return this.runExclusive(async (permit) => {
      const intents = await this.journal.listIntents(repositoryId);
      let recoveredAny = false;
      for (const intent of intents) {
        if (intent.localApplied) {
          continue;
        }
        const materialized = await this.journal.getOperationForIntent(
          intent.intentId
        );
        const recovered = await this.localAccounts.recoverIntent(
          intent,
          materialized,
          permit
        );
        if (recovered) {
          if (materialized) {
            await this.journal.advanceEntityHeads(intent, materialized.opId);
          }
          await this.journal.markIntentApplied(intent.intentId);
          await this.scheduler.markPending(intent.repositoryId);
          recoveredAny = true;
        }
      }
      if (recoveredAny) {
        this.scheduler.schedule(5000);
      }
    });
  }

  applyRemote(state: unknown) {
    return this.runExclusive((permit) =>
      this.localAccounts.applyRemote(state, permit)
    );
  }

  rewriteLocalEncryption(rewrite: () => Promise<void>) {
    return this.runExclusive((permit) =>
      this.localAccounts.rewriteLocalEncryption(rewrite, permit)
    );
  }
}
