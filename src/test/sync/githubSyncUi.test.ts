import "mocha";
import { assert } from "chai";
import {
  alarmCommand,
  applyIncomingGitHubStatus,
  buildGitHubConnectRequest,
  createBoundedKdf,
  emptyConnectionSecrets,
  genericSetupError,
  GITHUB_API_ORIGIN_PATTERN,
  GITHUB_SYNC_ALARM,
  githubConnectMessage,
  githubDisconnectMessage,
  githubForgetRepositoryMessage,
  githubGetStatusMessage,
  githubInspectMessage,
  githubInspectStoredMessage,
  githubRepositoryUrl,
  githubRepairLegacyPathsMessage,
  githubResolveConflictMessage,
  githubSyncManualMessage,
  isValidGithubIdentity,
  normalizeBackgroundMinutes,
  parseEncryptedConfig,
  parseRaceConfig,
  readBackgroundSettings,
  readStoredSyncPassword,
  readStoredSyncToken,
  runGithubConnect,
  SYNC_PASSWORD_STORAGE_KEY,
  SYNC_TOKEN_STORAGE_KEY,
  syncPasswordPersistPlan,
  statusLabelKey,
  statusMessageKey,
  triggerGithubPopupSync,
} from "../../sync/githubSyncUi";
import { encodeRepositoryKekMessage } from "../../sync/SyncMessage";
import {
  createEncryptedRepositoryConfig,
  createUnencryptedRepositoryConfig,
  EncryptedRepositoryConfig,
  serializeRepositoryConfig,
} from "../../sync/RepositoryConfig";
import { Argon2idKdfConfig } from "../../sync/SyncCrypto";

mocha.setup("bdd");

const KEK = new Uint8Array(32).fill(7);
const TOKEN = "ghp_super-secret-test-pat-never-logged";

function fixedEncryptedKek(password: string) {
  // Deterministic password -> KEK so local verification passes.
  return new Uint8Array(32).fill(password.length);
}

/** Returns a plain config object in canonical key order, like runtime data. */
async function makeEncryptedConfig(password: string) {
  const kdf = createBoundedKdf();
  const kek = fixedEncryptedKek(password);
  const { config } = await createEncryptedRepositoryConfig(kdf, kek);
  const canonical = JSON.parse(
    serializeRepositoryConfig(config),
  ) as EncryptedRepositoryConfig;
  return { config: canonical, kek, kdf };
}

describe("GitHub sync UI helpers", () => {
  it("provides Simplified Chinese text for every GitHub sync message", async () => {
    const readLocale = (path: "en" | "zh_CN") =>
      new Promise<Record<string, { message?: string }>>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open(
          "GET",
          chrome.runtime.getURL(`_locales/${path}/messages.json`),
        );
        request.onload = () =>
          resolve(
            JSON.parse(request.responseText) as Record<
              string,
              { message?: string }
            >,
          );
        request.onerror = () => reject(new Error("Unable to read locale"));
        request.send();
      });
    const [english, chinese] = await Promise.all([
      readLocale("en"),
      readLocale("zh_CN"),
    ]);
    const keys = Object.keys(english).filter(
      (key) => key.startsWith("github_") || key === "permission_github_api",
    );
    for (const key of keys) {
      assert.equal(typeof chinese[key]?.message, "string", key);
      assert.notEqual(chinese[key].message, english[key].message, key);
    }
  });

  it("starts a cold popup sync without blocking the first render", () => {
    let requested = false;
    const neverCompletes = new Promise<unknown>(() => undefined);

    const result = triggerGithubPopupSync(async (message) => {
      requested = message.action === "githubSyncPopup";
      return neverCompletes;
    });

    assert.isUndefined(result);
    assert.isTrue(requested);
  });

  describe("request action names", () => {
    it("builds the exact runtime messages", () => {
      assert.deepEqual(githubGetStatusMessage(), { action: "githubGetStatus" });
      assert.deepEqual(githubInspectStoredMessage(), {
        action: "githubInspectStored",
      });
      assert.deepEqual(githubSyncManualMessage(), {
        action: "githubSyncManual",
      });
      assert.deepEqual(githubRepairLegacyPathsMessage(), {
        action: "githubRepairLegacyPaths",
      });
      assert.deepEqual(
        githubResolveConflictMessage({
          entityType: "otp",
          entityId: "id-1",
          deleted: false,
        }),
        {
          action: "githubResolveConflict",
          command: { entityType: "otp", entityId: "id-1", deleted: false },
        },
      );
      assert.deepEqual(githubDisconnectMessage(), {
        action: "githubDisconnect",
      });
      assert.deepEqual(githubForgetRepositoryMessage(), {
        action: "githubForgetRepository",
      });
    });

    it("wraps the connect/inspect requests with their action names", () => {
      assert.deepEqual(githubInspectMessage({ owner: "alice" }), {
        action: "githubInspect",
        request: { owner: "alice" },
      });
      assert.deepEqual(githubConnectMessage({ owner: "alice" }), {
        action: "githubConnect",
        request: { owner: "alice" },
      });
    });
  });

  describe("mandatory encryption and no raw secrets", () => {
    it("builds a connect request with a strict Base64 KEK, never a password", () => {
      const request = buildGitHubConnectRequest({
        owner: "alice",
        repository: "auth-sync",
        token: TOKEN,
        rememberToken: true,
        kek: KEK,
      });
      assert.equal(request.branch, "authenticator-sync");
      assert.equal(request.rememberToken, true);
      assert.equal(request.rememberPassword, true);
      assert.equal(request.token, TOKEN);
      assert.equal(request.kek, encodeRepositoryKekMessage(KEK));
      assert.isUndefined(request.candidate);
      assert.notInclude(JSON.stringify(request), "syncPassword");
    });

    it("rejects a plaintext candidate and requires a KEK for any candidate", () => {
      assert.throws(() =>
        buildGitHubConnectRequest({
          owner: "alice",
          repository: "auth-sync",
          token: TOKEN,
          rememberToken: false,
          candidate: createUnencryptedRepositoryConfig() as never,
        }),
      );
      const config = createUnencryptedRepositoryConfig() as never;
      assert.throws(() =>
        buildGitHubConnectRequest({
          owner: "alice",
          repository: "auth-sync",
          token: TOKEN,
          rememberToken: false,
          candidate: config,
          kek: KEK,
        }),
      );
    });

    it("parses only encrypted configs and rejects plaintext configs", async () => {
      const { config } = await makeEncryptedConfig("swordfish");
      const parsed = parseEncryptedConfig(config);
      assert.equal(parsed.encryption.mode, "aes-256-gcm");
      assert.equal(parseRaceConfig(config).encryption.mode, "aes-256-gcm");
      assert.throws(() =>
        parseEncryptedConfig(createUnencryptedRepositoryConfig()),
      );
      assert.throws(() => parseEncryptedConfig(null));
      assert.throws(() => parseEncryptedConfig("not-a-config"));
    });
  });

  describe("secret clearing and identity validation", () => {
    it("empties every secret field", () => {
      assert.deepEqual(emptyConnectionSecrets(), {
        pat: "",
        syncPassword: "",
        syncPasswordConfirmation: "",
      });
    });

    it("reads and plans persistence of the sync password", () => {
      assert.equal(
        readStoredSyncPassword({
          [SYNC_PASSWORD_STORAGE_KEY]: "local-secret",
        }),
        "local-secret",
      );
      assert.equal(
        readStoredSyncPassword(
          {},
          { [SYNC_PASSWORD_STORAGE_KEY]: "session-secret" },
        ),
        "session-secret",
      );
      assert.deepEqual(syncPasswordPersistPlan("kept", true), {
        local: "kept",
        removeLocal: false,
        removeSession: true,
      });
      assert.deepEqual(syncPasswordPersistPlan("temp", false), {
        session: "temp",
        removeLocal: true,
        removeSession: false,
      });
      assert.deepEqual(syncPasswordPersistPlan("", true), {
        removeLocal: true,
        removeSession: true,
      });
    });

    it("keeps a live connection when a status-only broadcast says unconfigured", () => {
      const next = applyIncomingGitHubStatus(
        {
          status: "syncing",
          configured: true,
          unlocked: true,
          tokenRequired: false,
        },
        { status: "unconfigured" },
      );
      assert.deepInclude(next, {
        status: "syncing",
        configured: true,
        unlocked: true,
      });
    });

    it("applies a full unconfigured snapshot instead of staying on syncing", () => {
      const next = applyIncomingGitHubStatus(
        {
          status: "syncing",
          configured: true,
          unlocked: true,
          tokenRequired: false,
        },
        {
          status: "unconfigured",
          configured: false,
          unlocked: false,
          tokenRequired: false,
        },
      );
      assert.deepInclude(next, {
        status: "unconfigured",
        configured: false,
        unlocked: false,
      });
    });

    it("restores a remembered PAT from local or session storage", () => {
      assert.equal(
        readStoredSyncToken({
          [SYNC_TOKEN_STORAGE_KEY]: "github_pat_local",
        }),
        "github_pat_local",
      );
      assert.equal(
        readStoredSyncToken(
          {},
          { [SYNC_TOKEN_STORAGE_KEY]: "github_pat_session" },
        ),
        "github_pat_session",
      );
    });

    it("validates owner/repository and builds a safe open-repository URL", () => {
      assert.isTrue(isValidGithubIdentity("alice", "auth-sync"));
      assert.isFalse(isValidGithubIdentity("", "auth-sync"));
      assert.isFalse(isValidGithubIdentity("al ice", "auth-sync"));
      assert.isFalse(isValidGithubIdentity("alice", ".."));
      assert.equal(
        githubRepositoryUrl("alice", "auth-sync"),
        "https://github.com/alice/auth-sync",
      );
      assert.throws(() => githubRepositoryUrl("in valid", "repo"));
    });
  });

  describe("background alarm helper seams", () => {
    it("normalizes the interval to a minimum of five minutes", () => {
      assert.equal(normalizeBackgroundMinutes(5), 5);
      assert.equal(normalizeBackgroundMinutes(30), 30);
      assert.equal(normalizeBackgroundMinutes(3), 15);
      assert.equal(normalizeBackgroundMinutes("nope"), 15);
      assert.equal(normalizeBackgroundMinutes(17.9), 17);
      assert.deepEqual(
        readBackgroundSettings({
          githubBackgroundSyncEnabled: true,
          githubBackgroundSyncMinutes: 30,
        }),
        { enabled: true, minutes: 30 },
      );
      assert.deepEqual(
        readBackgroundSettings({
          githubBackgroundSyncEnabled: false,
          githubBackgroundSyncMinutes: 2,
        }),
        { enabled: false, minutes: 15 },
      );
    });

    it("translates the toggle into create/clear github-sync alarm commands", () => {
      assert.deepEqual(alarmCommand(true, 30), {
        name: GITHUB_SYNC_ALARM,
        create: true,
        minutes: 30,
      });
      assert.deepEqual(alarmCommand(false, 30), {
        name: GITHUB_SYNC_ALARM,
        create: false,
        minutes: 30,
      });
      assert.equal(alarmCommand(true, 2).minutes, 15);
    });
  });

  describe("status messages", () => {
    it("maps status labels and hides unknown raw status text", () => {
      assert.equal(statusLabelKey("synced"), "github_state_synced");
      assert.equal(
        statusLabelKey("historyRewritten"),
        "github_state_historyRewritten",
      );
      assert.equal(statusLabelKey(TOKEN), "github_state_error");
    });

    it("maps actionable statuses and never leaks raw statuses", () => {
      assert.equal(
        statusMessageKey("tokenRequired"),
        "github_status_token_required",
      );
      assert.equal(
        statusMessageKey("needsSyncPassword"),
        "github_status_needs_sync_password",
      );
      assert.equal(
        statusMessageKey("rateLimited"),
        "github_status_rate_limited",
      );
      assert.equal(
        statusMessageKey("branchProtected"),
        "github_status_branch_protected",
      );
      assert.equal(
        statusMessageKey("historyRewritten"),
        "github_status_history_rewritten",
      );
      assert.equal(
        statusMessageKey("repositoryChanged"),
        "github_status_repository_changed",
      );
      assert.equal(
        statusMessageKey("remoteMissing"),
        "github_status_remote_missing",
      );
      assert.equal(
        statusMessageKey("permissionRequired"),
        "github_status_permission_required",
      );
      assert.equal(statusMessageKey("authFailed"), "github_status_auth_failed");
      for (const status of [
        "unconfigured",
        "testing",
        "initializing",
        "pending",
        "syncing",
        "synced",
        "conflict",
      ]) {
        assert.equal(statusMessageKey(status), "");
      }
      assert.equal(
        statusMessageKey("totallyUnknownStatus"),
        "github_status_generic_error",
      );
    });

    it("returns a generic setup error that never echoes the underlying error", () => {
      const poisoned = new Error(`connect failed with ${TOKEN} body`);
      const message = genericSetupError(poisoned, "本地化的安全错误");
      assert.equal(message, "本地化的安全错误");
      assert.notInclude(message, TOKEN);
      assert.notInclude(message, "connect failed");
    });
  });

  describe("runGithubConnect", () => {
    function stubDeps(overrides: Record<string, unknown> = {}) {
      const calls = {
        connectRequests: [] as Array<Record<string, unknown>>,
        deriveKdfs: [] as Argon2idKdfConfig[],
        permission: true,
        inspectConfig: undefined as undefined | EncryptedRepositoryConfig,
        connectResults: [] as Array<Record<string, unknown>>,
      };
      if (typeof overrides.permission === "boolean") {
        calls.permission = overrides.permission;
      }
      if (overrides.inspectConfig !== undefined) {
        calls.inspectConfig =
          overrides.inspectConfig as EncryptedRepositoryConfig;
      }
      if (Array.isArray(overrides.connectResults)) {
        calls.connectResults = overrides.connectResults as Array<
          Record<string, unknown>
        >;
      }
      const deps = {
        requestPermission: async () => calls.permission,
        inspect: async () =>
          calls.inspectConfig === undefined
            ? { status: "unconfigured" }
            : { status: "existing", config: calls.inspectConfig },
        connect: async (request: Record<string, unknown>) => {
          calls.connectRequests.push(request);
          return calls.connectResults.shift() ?? { status: "initializing" };
        },
        deriveKek: async (password: string, kdf: Argon2idKdfConfig) => {
          calls.deriveKdfs.push(kdf);
          return fixedEncryptedKek(password);
        },
        generateKdf: () => {
          const kdf = createBoundedKdf();
          kdf.salt = "AAECAwQFBgcICQoLDA0ODw==";
          return kdf;
        },
        // Explicit function overrides (e.g. deriveKek) still win here.
        ...actionsFrom(overrides),
      };
      return { deps, calls };
    }

    function actionsFrom(overrides: Record<string, unknown>) {
      const actions: Record<string, unknown> = {};
      for (const key of [
        "inspect",
        "connect",
        "deriveKek",
        "generateKdf",
        "requestPermission",
      ]) {
        if (typeof overrides[key] === "function") {
          actions[key] = overrides[key];
        }
      }
      return actions;
    }

    function input(overrides: Record<string, unknown> = {}) {
      return {
        owner: "alice",
        repository: "auth-sync",
        token: TOKEN,
        rememberToken: false,
        syncPassword: "swordfish",
        syncPasswordConfirmation: "swordfish",
        configured: false,
        tokenRequired: false,
        ...overrides,
      };
    }

    it("creates a first encrypted config with password confirmation only once", async () => {
      const { deps, calls } = stubDeps();
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "success");
      assert.equal(calls.connectRequests.length, 1);
      const request = calls.connectRequests[0];
      const candidate = request.candidate as Record<string, unknown>;
      assert.equal(
        (candidate.encryption as Record<string, unknown>).mode,
        "aes-256-gcm",
      );
      assert.isDefined(request.kek);
      assert.notInclude(JSON.stringify(request), "syncPassword");
      assert.notInclude(JSON.stringify(request), "swordfish");
    });

    it("adopts an existing config using the entered password and its own KDF", async () => {
      const { config, kek } = await makeEncryptedConfig("swordfish");
      const encodedKek = encodeRepositoryKekMessage(kek);
      const { deps, calls } = stubDeps({
        inspect: async () => ({ status: "existing", config }),
        deriveKek: async (_password: string, kdf: Argon2idKdfConfig) => {
          calls.deriveKdfs.push(kdf);
          return kek;
        },
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "success");
      assert.deepEqual(calls.deriveKdfs[0], config.encryption.kdf);
      const request = calls.connectRequests[0];
      assert.isUndefined(request.candidate);
      assert.equal(request.kek, encodedKek);
      assert.deepEqual(Array.from(kek), new Array(32).fill(0));
    });

    it("surfaces a wrong password for an existing config without a remote round trip", async () => {
      const { config } = await makeEncryptedConfig("swordfish");
      const { deps, calls } = stubDeps({
        inspect: async () => ({ status: "existing", config }),
        deriveKek: async () => new Uint8Array(32).fill(1),
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "needsSyncPassword");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("requests only the GitHub API origin and stops on permission denial", async () => {
      const { deps, calls } = stubDeps({
        permission: false,
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "permissionRequired");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("preserves a safe classified inspection failure instead of showing a generic error", async () => {
      const { deps, calls } = stubDeps({
        inspect: async () => ({ status: "authFailed" }),
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "authFailed");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("preserves a safe classified connect failure instead of showing a generic error", async () => {
      const { deps } = stubDeps({
        connectResults: [{ status: "rateLimited" }],
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "rateLimited");
    });

    it("rejects a missing PAT for a new connection without any network use", async () => {
      const { deps, calls } = stubDeps();
      const outcome = await runGithubConnect(
        deps,
        input({ token: "", tokenRequired: true }),
      );

      assert.equal(outcome.status, "missingToken");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("requires the confirmation to match when creating the first config", async () => {
      const { deps, calls } = stubDeps();
      const outcome = await runGithubConnect(
        deps,
        input({ syncPasswordConfirmation: "different" }),
      );

      assert.equal(outcome.status, "passwordMismatch");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("re-derives against the winner KDF and retries connect once on a config race", async () => {
      const winner = await makeEncryptedConfig("swordfish");
      const { deps, calls } = stubDeps({
        connectResults: [
          { status: "configRace", config: winner.config },
          { status: "initializing" },
        ],
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "success");
      assert.equal(calls.connectRequests.length, 2);
      // The retry must carry only the KEK, never a candidate.
      const retry = calls.connectRequests[1];
      assert.isUndefined(retry.candidate);
      assert.equal(retry.kek, encodeRepositoryKekMessage(winner.kek));
      // Same entered password, but derived with the winner's KDF.
      assert.equal(calls.deriveKdfs.length, 2);
      assert.deepEqual(calls.deriveKdfs[1], winner.config.encryption.kdf);
    });

    it("turns a second config race into an actionable error", async () => {
      const winner = await makeEncryptedConfig("swordfish");
      const { deps, calls } = stubDeps({
        connectResults: [
          { status: "configRace", config: winner.config },
          { status: "configRace", config: winner.config },
        ],
      });
      const outcome = await runGithubConnect(deps, input());

      assert.equal(outcome.status, "configRaceFailed");
      assert.equal(outcome.errorKey, "github_error_config_race");
      assert.equal(calls.connectRequests.length, 2);
    });

    it("rejects invalid owner/repository up front", async () => {
      const { deps, calls } = stubDeps();
      const outcome = await runGithubConnect(
        deps,
        input({ owner: "bad name" }),
      );
      assert.equal(outcome.status, "invalidIdentity");
      assert.equal(calls.connectRequests.length, 0);
    });

    it("only ever requests the GitHub API origin pattern", async () => {
      let requested = "";
      const { deps } = stubDeps({
        requestPermission: async (origin: string) => {
          requested = origin;
          return true;
        },
      });
      await runGithubConnect(deps, input());
      assert.equal(requested, GITHUB_API_ORIGIN_PATTERN);
      assert.equal(requested, "https://api.github.com/*");
    });
  });
});
