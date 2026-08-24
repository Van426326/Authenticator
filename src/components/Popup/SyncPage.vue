<template>
  <div class="sync-page">
    <h2>{{ i18n.github_sync_title }}</h2>
    <div class="text">{{ i18n.github_status }}: {{ statusLabel }}</div>
    <div class="text" v-if="lastSuccessfulSyncAt">
      {{ i18n.github_last_sync }}:
      {{ new Date(lastSuccessfulSyncAt).toLocaleString() }}
    </div>

    <!-- Diagnosable backend statuses -->
    <div class="text warning" v-if="statusMessage">{{ statusMessage }}</div>
    <!-- Local validation / setup errors -->
    <div class="text warning" v-if="error">{{ error }}</div>

    <!-- Safe details snapshot from githubGetStatus -->
    <div class="sync-details" v-if="details">
      <div class="text" v-if="details.owner && details.repository">
        {{ details.owner }}/{{ details.repository }} (
        <code>{{ details.branch || githubSyncBranch }}</code>
        )
      </div>
      <div class="text" v-if="details.headShortSha">
        {{ i18n.github_details_head }}: <code>{{ details.headShortSha }}</code>
      </div>
      <div class="text" v-if="typeof details.pendingOperations === 'number'">
        {{ i18n.github_details_pending }}: {{ details.pendingOperations }}
      </div>
      <div class="text" v-if="typeof details.rateLimitRemaining === 'number'">
        {{ i18n.github_details_rate_remaining }}:
        {{ details.rateLimitRemaining }}
      </div>
      <div
        class="text"
        v-if="
          typeof details.rateLimitReset === 'number' &&
          details.rateLimitReset > 0
        "
      >
        {{ i18n.github_details_rate_reset }}:
        {{ new Date(details.rateLimitReset * 1000).toLocaleString() }}
      </div>
    </div>

    <!-- Owner / repository -->
    <label class="sync-field">
      <span>{{ i18n.github_owner }}</span>
      <input
        v-model.trim="owner"
        type="text"
        autocomplete="off"
        :disabled="configured"
      />
    </label>
    <label class="sync-field">
      <span>{{ i18n.github_repository }}</span>
      <input
        v-model.trim="repository"
        type="text"
        autocomplete="off"
        :disabled="configured"
      />
    </label>
    <div class="text">{{ i18n.github_repo_requirement }}</div>

    <!-- Fine-grained PAT -->
    <label class="sync-field" v-if="showPat">
      <span>{{ i18n.github_pat }}</span>
      <input
        v-model="pat"
        type="password"
        autocomplete="off"
        placeholder="github_pat_..."
      />
    </label>
    <label class="sync-field sync-checkbox" v-if="showPat || configured">
      <input v-model="rememberPat" type="checkbox" />
      <span>{{ i18n.github_remember_pat }}</span>
    </label>
    <div class="text" v-if="showPat">{{ i18n.github_pat_storage }}</div>
    <div class="text" v-if="showPat">{{ i18n.github_pat_permissions }}</div>

    <!-- Independent sync password -->
    <label class="sync-field" v-if="showPassword">
      <span>{{ i18n.github_sync_password }}</span>
      <input
        v-model="syncPassword"
        type="password"
        autocomplete="new-password"
      />
    </label>
    <label class="sync-field" v-if="showConfirmation">
      <span>{{ i18n.github_sync_password_confirm }}</span>
      <input
        v-model="syncPasswordConfirmation"
        type="password"
        autocomplete="new-password"
      />
    </label>
    <label class="sync-field sync-checkbox" v-if="showPassword || configured">
      <input v-model="rememberPassword" type="checkbox" />
      <span>{{ i18n.github_remember_password }}</span>
    </label>
    <div class="text" v-if="showPassword || configured">
      {{ i18n.github_password_storage }}
    </div>
    <div class="text" v-if="showPassword">
      {{ i18n.github_encryption_mandatory }}
    </div>
    <div class="text warning" v-if="showPassword">
      {{ i18n.github_password_warning }}
    </div>
    <div class="text" v-if="showPassword">
      {{ i18n.github_encryption_explanation }}
    </div>

    <!-- Fixed branch -->
    <div class="text">
      {{ i18n.github_branch }}: <code>{{ githubSyncBranch }}</code>
    </div>

    <!-- Background sync -->
    <label class="sync-field sync-checkbox">
      <input v-model="backgroundSync" type="checkbox" @change="updateAlarm" />
      <span>{{ i18n.github_background }}</span>
    </label>
    <label class="sync-field" v-if="backgroundSync">
      <span>{{ i18n.github_interval }}</span>
      <input
        v-model.number="backgroundSyncMinutes"
        type="number"
        min="5"
        @change="updateAlarm"
      />
    </label>

    <!-- Actions -->
    <button
      class="button"
      type="button"
      v-if="showConnectOrUnlock"
      :disabled="busy"
      @click="connectOrUnlock"
    >
      {{ busy ? i18n.github_working : actionLabel }}
    </button>
    <button
      class="button"
      type="button"
      :disabled="busy || !configured"
      @click="syncNow"
    >
      {{ i18n.github_sync_now }}
    </button>
    <button
      class="button warning-button"
      type="button"
      v-if="status === 'historyRewritten'"
      :disabled="busy || !configured"
      @click="repairLegacyPaths"
    >
      {{ i18n.github_repair_legacy_paths }}
    </button>
    <button
      class="button"
      type="button"
      :disabled="busy || !configured"
      @click="openRepository"
    >
      {{ i18n.github_open_repository }}
    </button>
    <button
      class="button danger"
      type="button"
      :disabled="busy || !configured"
      @click="disconnect"
    >
      {{ i18n.github_disconnect }}
    </button>
    <button
      class="button danger"
      type="button"
      :disabled="busy || !configured"
      @click="forgetRepository"
    >
      {{ i18n.github_forget }}
    </button>

    <!-- Conflicts -->
    <div class="sync-conflicts" v-if="conflicts.length">
      <h3>{{ i18n.github_conflicts }}</h3>
      <div
        class="sync-conflict"
        v-for="conflict in conflicts"
        :key="conflict.entityId"
      >
        <strong>{{ conflict.entityId }}</strong>
        <button
          class="button"
          type="button"
          v-for="branch in conflict.branches"
          :key="branch.opId"
          :disabled="busy"
          @click="resolveConflict(conflict, branch)"
        >
          {{ i18n.github_keep }} {{ branchLabel(branch) }}
        </button>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { createSyncKdfClient } from "../../sync/SyncKdfClient";
import {
  alarmCommand,
  applyIncomingGitHubStatus,
  createBoundedKdf,
  DEFAULT_BACKGROUND_MINUTES,
  emptyConnectionSecrets,
  genericSetupError,
  GITHUB_API_ORIGIN_PATTERN,
  githubConnectMessage,
  githubDisconnectMessage,
  githubForgetRepositoryMessage,
  githubGetConflictsMessage,
  githubGetStatusMessage,
  githubInspectMessage,
  githubInspectStoredMessage,
  githubRepositoryUrl,
  githubRepairLegacyPathsMessage,
  githubResolveConflictMessage,
  githubSyncManualMessage,
  githubUnlockMessage,
  GITHUB_SYNC_ALARM,
  GITHUB_SYNC_BRANCH_DISPLAY,
  normalizeBackgroundMinutes,
  parseEncryptedConfig,
  readBackgroundSettings,
  readStoredSyncPassword,
  readStoredSyncToken,
  runGithubConnect,
  statusLabelKey,
  statusMessageKey,
  SYNC_PASSWORD_STORAGE_KEY,
  SYNC_TOKEN_STORAGE_KEY,
  syncPasswordPersistPlan,
} from "../../sync/githubSyncUi";
import { Argon2idKdfConfig } from "../../sync/SyncCrypto";
import { EncryptedRepositoryConfig } from "../../sync/RepositoryConfig";
import { githubSecretFields } from "../../sync/GitHubStatusView";

interface SyncStatusResponse {
  status?: string;
  updatedAt?: number;
  lastSuccessfulSyncAt?: number;
  details?: GitHubSyncDetails;
  configured?: boolean;
  unlocked?: boolean;
  tokenRequired?: boolean;
}

interface GitHubSyncDetails {
  owner?: string;
  repository?: string;
  branch?: string;
  headShortSha?: string;
  pendingOperations?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}

interface ConflictBranch {
  opId: string;
  deviceId: string;
  createdAt: number;
  deleted: boolean;
  payload?: Record<string, unknown>;
}

interface ConflictSummary {
  entityType: "otp" | "order";
  entityId: string;
  branches: ConflictBranch[];
}

function requestGitHubPermission(
  origin = GITHUB_API_ORIGIN_PATTERN
): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: [origin] }, resolve);
  });
}

export default Vue.extend({
  data() {
    return {
      owner: "",
      repository: "",
      pat: "",
      rememberPat: true,
      rememberPassword: true,
      syncPassword: "",
      syncPasswordConfirmation: "",
      busy: false,
      configured: false,
      unlocked: false,
      tokenRequired: false,
      config: undefined as EncryptedRepositoryConfig | undefined,
      status: "unconfigured",
      lastSuccessfulSyncAt: 0,
      error: "",
      details: undefined as GitHubSyncDetails | undefined,
      conflicts: [] as ConflictSummary[],
      backgroundSync: false,
      backgroundSyncMinutes: 15,
      githubSyncBranch: GITHUB_SYNC_BRANCH_DISPLAY,
    };
  },
  computed: {
    secretFields() {
      return githubSecretFields({
        configured: this.configured,
        unlocked: this.unlocked,
        tokenRequired: this.tokenRequired,
        hasRemoteConfig: Boolean(this.config),
      });
    },
    showPat(): boolean {
      return this.secretFields.showPat;
    },
    showPassword(): boolean {
      return this.secretFields.showPassword;
    },
    showConfirmation(): boolean {
      return this.secretFields.showConfirmation;
    },
    showConnectOrUnlock(): boolean {
      return this.secretFields.showConnectOrUnlock;
    },
    actionLabel(): string {
      return this.configured
        ? this.i18n.github_unlock
        : this.i18n.github_connect;
    },
    statusLabel(): string {
      const key = statusLabelKey(this.status);
      return (this.i18n as Record<string, string>)[key] || "";
    },
    statusMessage(): string {
      if (this.status && this.status !== "unconfigured") {
        const key = statusMessageKey(this.status);
        const message = (this.i18n as Record<string, string>)[key];
        if (message) {
          return message;
        }
      }
      return "";
    },
  },
  async mounted() {
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    await this.refreshStatus();
    const values = await chrome.storage.local.get([
      "githubSyncConnection",
      "githubBackgroundSyncEnabled",
      "githubBackgroundSyncMinutes",
      SYNC_PASSWORD_STORAGE_KEY,
      SYNC_TOKEN_STORAGE_KEY,
    ]);
    const sessionValues = await chrome.storage.session.get([
      SYNC_PASSWORD_STORAGE_KEY,
      SYNC_TOKEN_STORAGE_KEY,
    ]);
    const background = readBackgroundSettings(values);
    this.backgroundSync = background.enabled;
    this.backgroundSyncMinutes = background.minutes;
    const connection = values.githubSyncConnection as
      | Record<string, unknown>
      | undefined;
    this.configured = Boolean(connection);
    this.rememberPat = connection ? connection.rememberToken === true : true;
    this.rememberPassword = connection
      ? connection.rememberPassword !== false
      : true;
    this.syncPassword = readStoredSyncPassword(values, sessionValues);
    this.pat = readStoredSyncToken(values, sessionValues);
    this.commitConfigured(this.configured);
    if (connection) {
      this.owner = String(connection.owner || "");
      this.repository = String(connection.repository || "");
      await this.loadStoredConfig();
    }
    await this.restoreAlarm();
  },
  beforeDestroy() {
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    this.clearConnectionSecrets();
  },
  methods: {
    onRuntimeMessage(message: {
      action?: string;
      status?: SyncStatusResponse;
    }) {
      if (message.action === "githubSyncStatus" && message.status) {
        this.applyStatus(message.status);
      }
    },
    /** Overridable seams so tests can avoid the Argon2 sandbox. */
    deriveKek(password: string, kdf: Argon2idKdfConfig) {
      return createSyncKdfClient().deriveKey(password, kdf);
    },
    sendMessage(message: unknown) {
      return chrome.runtime.sendMessage(message);
    },
    async persistSyncPassword() {
      const plan = syncPasswordPersistPlan(
        this.syncPassword,
        this.rememberPassword
      );
      if (plan.local !== undefined) {
        await chrome.storage.local.set({
          [SYNC_PASSWORD_STORAGE_KEY]: plan.local,
        });
      }
      if (plan.session !== undefined) {
        await chrome.storage.session.set({
          [SYNC_PASSWORD_STORAGE_KEY]: plan.session,
        });
      }
      if (plan.removeLocal) {
        await chrome.storage.local.remove(SYNC_PASSWORD_STORAGE_KEY);
      }
      if (plan.removeSession) {
        await chrome.storage.session.remove(SYNC_PASSWORD_STORAGE_KEY);
      }
    },
    async clearPersistedSyncPassword() {
      await chrome.storage.local.remove(SYNC_PASSWORD_STORAGE_KEY);
      await chrome.storage.session.remove(SYNC_PASSWORD_STORAGE_KEY);
    },
    clearConnectionSecrets() {
      const emptied = emptyConnectionSecrets();
      if (!this.rememberPat) {
        this.pat = emptied.pat;
      }
      if (!this.rememberPassword) {
        this.syncPassword = emptied.syncPassword;
      }
      this.syncPasswordConfirmation = emptied.syncPasswordConfirmation;
    },
    commitConfigured(configured: boolean) {
      this.configured = configured;
      this.$store.commit("sync/setConfigured", configured);
    },
    applyStatus(value: SyncStatusResponse) {
      const next = applyIncomingGitHubStatus(
        {
          status: this.status,
          configured: this.configured,
          unlocked: this.unlocked,
          tokenRequired: this.tokenRequired,
          lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
          details: this.details,
        },
        value || {}
      );
      this.status = next.status;
      this.commitConfigured(next.configured);
      this.unlocked = next.unlocked;
      this.tokenRequired = next.tokenRequired;
      if (typeof next.lastSuccessfulSyncAt === "number") {
        this.lastSuccessfulSyncAt = next.lastSuccessfulSyncAt;
      }
      this.details = next.details as GitHubSyncDetails | undefined;
      if (this.status === "conflict") {
        void this.refreshConflicts();
      } else if (this.status) {
        this.conflicts = [];
      }
    },
    async refreshStatus() {
      let response: SyncStatusResponse;
      try {
        response = (await this.sendMessage(
          githubGetStatusMessage()
        )) as SyncStatusResponse;
      } catch {
        this.status = "offline";
        return;
      }
      this.applyStatus(response);
    },
    async loadStoredConfig() {
      this.config = undefined;
      this.tokenRequired = false;
      let result: Record<string, unknown>;
      try {
        result = (await this.sendMessage(
          githubInspectStoredMessage()
        )) as Record<string, unknown>;
      } catch {
        this.status = "error";
        return;
      }
      const status = result?.status;
      if (status === "existing") {
        try {
          this.config = parseEncryptedConfig(result.config);
        } catch {
          this.status = "error";
        }
      } else if (status === "tokenRequired") {
        this.tokenRequired = true;
      } else if (status === "permissionRequired") {
        this.status = "permissionRequired";
      } else if (status === "remoteMissing") {
        this.status = "remoteMissing";
      } else if (status === "unconfigured") {
        const stored = await chrome.storage.local.get("githubSyncConnection");
        if (!stored.githubSyncConnection) {
          this.commitConfigured(false);
          this.unlocked = false;
        }
      } else if (typeof status === "string") {
        this.status = status;
      }
    },
    async restoreAlarm() {
      const command = alarmCommand(
        this.backgroundSync,
        this.backgroundSyncMinutes
      );
      if (typeof chrome.alarms === "undefined") {
        return;
      }
      try {
        if (command.create) {
          await chrome.alarms.create(command.name, {
            periodInMinutes: command.minutes,
          });
        } else {
          await chrome.alarms.clear(command.name);
        }
      } catch {
        // Alarms are best-effort in a standalone PWA build.
      }
    },
    async updateAlarm() {
      const minutes = normalizeBackgroundMinutes(this.backgroundSyncMinutes);
      this.backgroundSyncMinutes = minutes;
      await chrome.storage.local.set({
        githubBackgroundSyncEnabled: this.backgroundSync,
        githubBackgroundSyncMinutes: minutes,
      });
      const command = alarmCommand(this.backgroundSync, minutes);
      if (command.create && typeof chrome.alarms !== "undefined") {
        try {
          await chrome.alarms.create(command.name, {
            periodInMinutes: command.minutes,
          });
        } catch {
          // Best-effort alarm creation.
        }
      } else if (typeof chrome.alarms !== "undefined") {
        try {
          await chrome.alarms.clear(command.name);
        } catch {
          // Best-effort alarm clearing.
        }
      }
    },
    async repairLegacyPaths() {
      if (!window.confirm(this.i18n.github_repair_legacy_paths_confirm)) {
        return;
      }
      this.busy = true;
      this.error = "";
      try {
        const result = (await this.sendMessage(
          githubRepairLegacyPathsMessage()
        )) as Record<string, unknown>;
        if (result?.status !== "repaired") {
          this.status = String(result?.status || "error");
          return;
        }
        await this.sendMessage(githubSyncManualMessage());
        await this.refreshStatus();
      } catch (error) {
        try {
          await this.refreshStatus();
        } catch {
          this.error = genericSetupError(error);
        }
      } finally {
        this.busy = false;
      }
    },
    async syncNow() {
      this.busy = true;
      this.error = "";
      try {
        await this.sendMessage(githubSyncManualMessage());
        await this.refreshStatus();
      } catch (error) {
        // The background runner persists a safe, classified status before it
        // rejects. Refresh that status and avoid stacking a generic setup
        // error on top of an actionable message such as rateLimited or a
        // branch-rule rejection.
        try {
          await this.refreshStatus();
        } catch {
          // Fall through to the local generic message when status refresh also
          // fails; raw runtime errors are never displayed.
        }
        if (!statusMessageKey(this.status)) {
          this.error = genericSetupError(error);
        }
      } finally {
        this.busy = false;
      }
    },
    openRepository() {
      try {
        const url = githubRepositoryUrl(this.owner, this.repository);
        chrome.tabs.create({ url });
      } catch {
        this.error = this.i18n.github_error_invalid_identity;
      }
    },
    async refreshConflicts() {
      const conflicts = await this.sendMessage(githubGetConflictsMessage());
      this.conflicts = Array.isArray(conflicts) ? conflicts : [];
    },
    branchLabel(branch: ConflictBranch) {
      if (branch.deleted) {
        return `${this.i18n.github_conflict_deletion} ${branch.deviceId}`;
      }
      const issuer = branch.payload?.issuer;
      const account = branch.payload?.account;
      const label = [issuer, account]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join(" / ");
      return (
        label || `${this.i18n.github_conflict_revision} ${branch.deviceId}`
      );
    },
    async resolveConflict(conflict: ConflictSummary, branch: ConflictBranch) {
      this.busy = true;
      this.error = "";
      try {
        await this.sendMessage(
          githubResolveConflictMessage({
            entityType: conflict.entityType,
            entityId: conflict.entityId,
            deleted: branch.deleted,
            payload: branch.payload,
          })
        );
        await this.sendMessage(githubSyncManualMessage());
        await this.refreshStatus();
      } catch (error) {
        this.error = genericSetupError(error);
      } finally {
        this.busy = false;
      }
    },
    async connectOrUnlock() {
      this.busy = true;
      this.error = "";
      try {
        if (this.configured && !this.tokenRequired) {
          const granted = await requestGitHubPermission();
          if (!granted) {
            this.status = "permissionRequired";
            return;
          }
          await this.loadStoredConfig();
          if (this.tokenRequired) {
            await this.connect();
          } else if (this.config) {
            await this.unlockStored();
          }
        } else {
          await this.connect();
        }
      } catch (error) {
        this.error = genericSetupError(error);
      } finally {
        this.clearConnectionSecrets();
        this.busy = false;
      }
    },
    async connect() {
      const outcome = await runGithubConnect(
        {
          requestPermission: (origin) => requestGitHubPermission(origin),
          inspect: (request) => this.sendMessage(githubInspectMessage(request)),
          connect: (request) => this.sendMessage(githubConnectMessage(request)),
          deriveKek: (password, kdf) => this.deriveKek(password, kdf),
          generateKdf: () => createBoundedKdf(),
        },
        {
          owner: this.owner,
          repository: this.repository,
          token: this.pat,
          rememberToken: this.rememberPat,
          rememberPassword: this.rememberPassword,
          syncPassword: this.syncPassword,
          syncPasswordConfirmation: this.syncPasswordConfirmation,
          configured: this.configured,
          tokenRequired: this.tokenRequired,
        }
      );
      if (outcome.status === "success") {
        await this.persistSyncPassword();
        this.clearConnectionSecrets();
        this.commitConfigured(true);
        this.unlocked = true;
        this.tokenRequired = false;
        await this.loadStoredConfig();
        await this.refreshStatus();
        return;
      }
      this.clearConnectionSecrets();
      if (outcome.errorKey) {
        this.error = this.i18n[outcome.errorKey];
        return;
      }
      this.status = outcome.status;
    },
    async unlockStored() {
      if (!this.config) {
        this.status = "needsSyncPassword";
        this.error = this.i18n.github_status_needs_sync_password;
        return;
      }
      if (!this.syncPassword) {
        this.status = "needsSyncPassword";
        this.error = this.i18n.github_status_needs_sync_password;
        return;
      }
      let kek: Uint8Array;
      try {
        kek = await this.deriveKek(
          this.syncPassword,
          this.config.encryption.kdf
        );
      } catch (error) {
        this.error = genericSetupError(error);
        return;
      }
      let result: Record<string, unknown>;
      try {
        result = (await this.sendMessage(
          githubUnlockMessage(kek, this.rememberPassword)
        )) as Record<string, unknown>;
      } catch (error) {
        this.error = genericSetupError(error);
        return;
      } finally {
        kek.fill(0);
      }
      const status = String(result?.status || "");
      if (status === "unlocked") {
        await this.persistSyncPassword();
        this.unlocked = true;
        await this.refreshStatus();
      } else if (status === "tokenRequired") {
        this.tokenRequired = true;
        this.error = this.i18n.github_status_token_required;
      } else if (status === "needsSyncPassword") {
        this.status = "needsSyncPassword";
        this.error = this.i18n.github_status_needs_sync_password;
      } else if (status === "remoteMissing") {
        this.status = "remoteMissing";
        this.error = this.i18n.github_status_remote_missing;
      } else if (status === "permissionRequired") {
        this.status = "permissionRequired";
        this.error = this.i18n.github_status_permission_required;
      } else if (status) {
        this.status = status;
      } else {
        this.error = this.i18n.github_status_generic_error;
      }
    },
    async forgetRepository() {
      if (
        !window.confirm(this.i18n.github_forget_confirm) ||
        !window.confirm(this.i18n.github_forget_confirm_again)
      ) {
        return;
      }
      this.busy = true;
      this.error = "";
      try {
        const response = (await this.sendMessage(
          githubForgetRepositoryMessage()
        )) as SyncStatusResponse;
        if (response && typeof response.status === "string") {
          this.status = response.status;
        }
        await this.clearPersistedSyncPassword();
        this.resetConfigUi();
      } catch (error) {
        this.error = genericSetupError(error);
      } finally {
        this.busy = false;
      }
    },
    async disconnect() {
      this.busy = true;
      this.error = "";
      try {
        const response = (await this.sendMessage(
          githubDisconnectMessage()
        )) as SyncStatusResponse;
        if (response && typeof response.status === "string") {
          this.status = response.status;
        }
        await this.clearPersistedSyncPassword();
        this.resetConfigUi();
      } catch (error) {
        this.error = genericSetupError(error);
      } finally {
        this.busy = false;
      }
    },
    resetConfigUi() {
      this.commitConfigured(false);
      this.unlocked = false;
      this.tokenRequired = false;
      this.config = undefined;
      this.rememberPat = true;
      this.rememberPassword = true;
      const emptied = emptyConnectionSecrets();
      this.pat = emptied.pat;
      this.syncPassword = emptied.syncPassword;
      this.syncPasswordConfirmation = emptied.syncPasswordConfirmation;
      this.backgroundSync = false;
      this.backgroundSyncMinutes = DEFAULT_BACKGROUND_MINUTES;
      this.status = "unconfigured";
      this.lastSuccessfulSyncAt = 0;
      this.details = undefined;
      this.conflicts = [];
      this.owner = "";
      this.repository = "";
      if (typeof chrome.alarms !== "undefined") {
        void chrome.alarms.clear(GITHUB_SYNC_ALARM).catch(() => undefined);
      }
    },
  },
});
</script>
