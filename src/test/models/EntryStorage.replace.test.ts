import "mocha";
import { assert } from "chai";
import { OTPEntry, OTPType } from "../../models/otp";
import { EntryStorage } from "../../models/storage";
import { StorageLocation, UserSettings } from "../../models/settings";

mocha.setup("bdd");

const RESERVED_KEYS = [
  "githubSyncConnection",
  "githubSyncStatus",
  "githubSyncToken",
  "githubSyncPassword",
  "githubRepositoryDataKey",
  "githubSyncDetails",
  "githubDeviceId",
  "githubBackgroundSyncEnabled",
  "githubBackgroundSyncMinutes",
];

describe("EntryStorage.replace", () => {
  it("does not delete GitHub sync keys when replacing local accounts", async () => {
    const previous = await chrome.storage.local.get(null);
    const previousLocation = UserSettings.items.storageLocation;
    try {
      await chrome.storage.local.set({
        githubSyncConnection: {
          formatVersion: 1,
          owner: "alice",
          repository: "codes",
        },
        githubSyncStatus: { status: "synced", updatedAt: 1 },
        githubSyncToken: "ghp_should-survive-replace",
        githubSyncPassword: "sync-password-should-survive",
        githubRepositoryDataKey: "data-key-should-survive",
        githubSyncDetails: { owner: "alice", repository: "codes" },
        githubDeviceId: "11111111-1111-4111-8111-111111111111",
        githubBackgroundSyncEnabled: true,
        githubBackgroundSyncMinutes: 15,
      });
      UserSettings.items.storageLocation = StorageLocation.Local;
      await UserSettings.commitItems();

      const entry = new OTPEntry({
        encrypted: false,
        hash: "replace-preserve-sync-keys",
        index: 0,
        secret: "JBSWY3DPEHPK3PXP",
        type: OTPType.totp,
        issuer: "Example",
        account: "user",
      });

      await EntryStorage.replace([entry]);

      const leftover = await chrome.storage.local.get(RESERVED_KEYS);
      assert.deepInclude(leftover, {
        githubSyncConnection: {
          formatVersion: 1,
          owner: "alice",
          repository: "codes",
        },
        githubSyncStatus: { status: "synced", updatedAt: 1 },
        githubSyncToken: "ghp_should-survive-replace",
        githubSyncPassword: "sync-password-should-survive",
        githubRepositoryDataKey: "data-key-should-survive",
        githubSyncDetails: { owner: "alice", repository: "codes" },
        githubDeviceId: "11111111-1111-4111-8111-111111111111",
        githubBackgroundSyncEnabled: true,
        githubBackgroundSyncMinutes: 15,
      });
    } finally {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(previous);
      UserSettings.items.storageLocation = previousLocation;
      if (previousLocation) {
        await UserSettings.commitItems();
      }
    }
  });
});
