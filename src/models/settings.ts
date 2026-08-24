export enum StorageLocation {
  Sync = "sync",
  Local = "local",
}

function parseJsonSetting(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Stored JSON setting is invalid");
  }
}

function cloneSerializableSettings(value: UserSettingsData) {
  try {
    return JSON.parse(JSON.stringify(value)) as UserSettingsData;
  } catch {
    throw new Error("Settings cannot be serialized");
  }
}

interface UserSettingsData {
  // local settings
  offset?: number;
  popupWidth?: number;
  storageLocation?: StorageLocation;

  // syncable settings
  advisorIgnoreList?: string[];
  autofill?: boolean;
  autolock?: number;
  enableContextMenu?: boolean;
  encodedPhrase?: string;
  smartFilter?: boolean;
  theme?: string;
  zoom?: number;
}

const LegacyCloudSettingKeys = [
  "driveEncrypted",
  "driveFolder",
  "driveRefreshToken",
  "driveRevoked",
  "driveToken",
  "dropboxEncrypted",
  "dropboxRevoked",
  "dropboxToken",
  "lastRemindingBackupTime",
  "oneDriveBusiness",
  "oneDriveEncrypted",
  "oneDriveRevoked",
  "oneDriveRefreshToken",
  "oneDriveToken",
];

// Maybe we can have a better way to define this
const LocalUserSettingsDataKeys = ["offset", "popupWidth", "storageLocation"];

export class UserSettings {
  static items: UserSettingsData = {};

  static async updateItems() {
    UserSettings.items = await UserSettings.getAllItems();
  }

  static async removeLegacyCloudSettings() {
    for (const location of [StorageLocation.Local, StorageLocation.Sync]) {
      const stored = await chrome.storage[location].get("UserSettings");
      const settings = stored.UserSettings;
      if (!settings || typeof settings !== "object") {
        continue;
      }
      let changed = false;
      for (const key of LegacyCloudSettingKeys) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
          delete settings[key];
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage[location].set({ UserSettings: settings });
      }
    }
    await UserSettings.updateItems();
  }

  static async convertFromLocalStorage(
    data: Storage,
    location: StorageLocation
  ) {
    const settings: UserSettingsData = {};

    for (const key in data) {
      if (isBooleanOption(key)) {
        settings[key] = data[key] === "true";
      } else if (isNumberOption(key)) {
        settings[key] = Number(data[key]);
      } else if (isJSONOption(key)) {
        settings[key] = parseJsonSetting(data[key]);
      } else {
        settings[key as keyof UserSettingsData] = data[key];
      }
    }

    settings.storageLocation = location;
    UserSettings.items = settings;
    await UserSettings.commitItems();
  }

  static async commitItems() {
    const storageLocation =
      UserSettings.items.storageLocation || StorageLocation.Local;

    if (storageLocation === StorageLocation.Local) {
      await chrome.storage[storageLocation].set({
        // JSON.parse(JSON.stringify()) strips functions (e.g. getItem, setItem, ...) which may have been added to the object.
        // Without this, a crash may occur as chrome.storage throws an error when trying to serialize a function.
        UserSettings: cloneSerializableSettings(UserSettings.items),
      });
    } else {
      const { syncableSettings, localSettings } = UserSettings.splitSettings(
        UserSettings.items
      );

      await Promise.all([
        chrome.storage[StorageLocation.Local].set({
          UserSettings: cloneSerializableSettings(localSettings),
        }),
        chrome.storage[StorageLocation.Sync].set({
          UserSettings: cloneSerializableSettings(syncableSettings),
        }),
      ]);
    }

    await UserSettings.updateItems();
  }

  static async removeItem(key: keyof UserSettingsData) {
    const localSettings = await UserSettings.getStorageData(
      StorageLocation.Local
    );
    const storageLocation =
      localSettings.storageLocation || StorageLocation.Local;

    const location = LocalUserSettingsDataKeys.includes(key)
      ? StorageLocation.Local
      : storageLocation;
    const storageData: UserSettingsData =
      (await chrome.storage[location].get("UserSettings"))?.UserSettings || {};
    delete storageData[key];

    UserSettings.items = storageData;

    await UserSettings.commitItems();
  }

  private static async getStorageData(location: StorageLocation) {
    const storageData: UserSettingsData =
      (await chrome.storage[location].get("UserSettings"))?.UserSettings || {};

    return storageData;
  }

  private static splitSettings(storageData: UserSettingsData) {
    const syncableSettings: UserSettingsData = Object.assign({}, storageData);
    const localSettings: UserSettingsData = Object.assign({}, storageData);

    let key: keyof UserSettingsData;
    for (key in storageData) {
      if (LocalUserSettingsDataKeys.includes(key)) {
        delete syncableSettings[key];
      } else {
        delete localSettings[key];
      }
    }

    return {
      syncableSettings,
      localSettings,
    };
  }

  private static async getAllItems() {
    const localSettings = await UserSettings.getStorageData(
      StorageLocation.Local
    );
    const storageLocation =
      localSettings.storageLocation || StorageLocation.Local;

    if (storageLocation === StorageLocation.Local) {
      return localSettings;
    }

    const syncableSettings = await UserSettings.getStorageData(
      StorageLocation.Sync
    );
    return { ...syncableSettings, ...localSettings };
  }
}

type BooleanOption = "autofill" | "enableContextMenu" | "smartFilter";

type NumberOption = "autolock" | "offset" | "popupWidth" | "zoom";

type JSONOption = "advisorIgnoreList";

function isBooleanOption(key: string): key is BooleanOption {
  return ["autofill", "enableContextMenu", "smartFilter"].includes(key);
}

function isNumberOption(key: string): key is NumberOption {
  return ["autolock", "offset", "popupWidth", "zoom"].includes(key);
}

function isJSONOption(key: string): key is JSONOption {
  return ["advisorIgnoreList"].includes(key);
}
