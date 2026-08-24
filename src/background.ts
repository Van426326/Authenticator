import { Encryption } from "./models/encryption";
import { EntryStorage, ManagedStorage } from "./models/storage";
import {
  getSiteName,
  getMatchedEntries,
  getCurrentTab,
  okToInjectContentScript,
} from "./utils";
import { CodeState } from "./models/otp";
import { POPUP_HEIGHT, resolvePopupWidth } from "./models/display";

import { getOTPAuthPerLineFromOPTAuthMigration } from "./models/migration";
import { isFirefox } from "./browser";
import { UserSettings } from "./models/settings";
import { createBackgroundSyncRuntime } from "./sync/SyncRuntime";
import {
  assertGitHubMessageTrusted,
  parseGitHubConnectRequest,
} from "./sync/GitHubMessage";
import { decodeRepositoryKekMessage } from "./sync/SyncMessage";

const gitHubSyncRuntime = createBackgroundSyncRuntime();

function assertInternalGitHubMessage(
  message: { action?: unknown },
  sender: chrome.runtime.MessageSender
) {
  assertGitHubMessageTrusted(message, sender, chrome.runtime);
}

let contentTab: chrome.tabs.Tab | undefined;

async function handleRuntimeMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  sender: chrome.runtime.MessageSender
) {
  await UserSettings.updateItems();

  if (message.action === "githubAccountMutation") {
    const runtime = await gitHubSyncRuntime;
    return { handled: await runtime.mutate(message.command) };
  }
  if (message.action === "githubInspect") {
    const runtime = await gitHubSyncRuntime;
    return runtime.inspect(parseGitHubConnectRequest(message.request));
  }
  if (message.action === "githubInspectStored") {
    const runtime = await gitHubSyncRuntime;
    return runtime.inspectStored();
  }
  if (message.action === "githubUnlock") {
    const runtime = await gitHubSyncRuntime;
    return runtime.unlock(
      decodeRepositoryKekMessage(message.kek),
      message.rememberPassword === true
    );
  }
  if (message.action === "githubConnect") {
    const runtime = await gitHubSyncRuntime;
    return runtime.connect(parseGitHubConnectRequest(message.request));
  }
  if (message.action === "githubRepairLegacyPaths") {
    const runtime = await gitHubSyncRuntime;
    return runtime.repairLegacyOperationPaths();
  }
  if (message.action === "githubDisconnect") {
    const runtime = await gitHubSyncRuntime;
    await runtime.disconnect();
    return { status: "unconfigured", configured: false, unlocked: false };
  }
  if (message.action === "githubForgetRepository") {
    const runtime = await gitHubSyncRuntime;
    await runtime.forgetRepository();
    return { status: "unconfigured", configured: false, unlocked: false };
  }
  if (message.action === "githubGetStatus") {
    const runtime = await gitHubSyncRuntime;
    return runtime.getStatus();
  }
  if (message.action === "githubGetConflicts") {
    const runtime = await gitHubSyncRuntime;
    return runtime.listConflicts();
  }
  if (message.action === "githubResolveConflict") {
    const runtime = await gitHubSyncRuntime;
    return { resolved: await runtime.resolveConflict(message.command) };
  }
  if (message.action === "githubSyncPopup") {
    const runtime = await gitHubSyncRuntime;
    await runtime.triggers.immediate("popup");
    return;
  }
  if (message.action === "githubSyncManual") {
    const runtime = await gitHubSyncRuntime;
    await runtime.triggers.immediate("manual");
    return;
  }
  if (message.action === "getCapture") {
    if (!sender.tab) {
      return;
    }
    const url = await getCapture(sender.tab);
    if (contentTab && contentTab.id) {
      message.info = message.info || {};
      message.info.url = url;
      chrome.tabs.sendMessage(contentTab.id, {
        action: "sendCaptureUrl",
        info: message.info,
      });
    }
    return;
  }
  if (message.action === "getTotp") {
    getTotp(message.info);
    return;
  }
  if (message.action === "cachePassphrase") {
    await chrome.storage.session.set({
      cachedPassphrase: message.value,
      cachedKeyId: message.keyId,
    });
    await chrome.alarms.clear("autolock");
    await setAutolock();
    const runtime = await gitHubSyncRuntime;
    await runtime.triggers.immediate("popup");
    return;
  }
  if (message.action === "lock") {
    // The sync PAT, repository data key, and pending uploads are independent
    // of the local account lock; clearing them here would block encrypted
    // pending upload/recovery while locked.
    await chrome.storage.session.set({
      cachedPassphrase: null,
      cachedKeyId: null,
    });
    return;
  }
  if (message.action === "resetAutolock") {
    chrome.alarms.clear("autolock");
    setAutolock();
    return;
  }
  if (message.action === "updateContentTab") {
    contentTab = message.data;
    return;
  }
  if (message.action === "updateContextMenu") {
    updateContextMenu();
  }
  return;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    assertInternalGitHubMessage(message, sender);
  } catch {
    return;
  }
  void handleRuntimeMessage(message, sender).then(
    (result) => sendResponse(result),
    () => sendResponse(undefined)
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "github-sync") {
    void chrome.storage.local
      .get("githubBackgroundSyncEnabled")
      .then((values) => {
        if (values.githubBackgroundSyncEnabled !== true) {
          return undefined;
        }
        return gitHubSyncRuntime.then((runtime) =>
          runtime.triggers.immediate("alarm")
        );
      })
      .catch(() => undefined);
    return true;
  }
  if (alarm.name !== "autolock") {
    return;
  }
  chrome.storage.session.set({
    cachedPassphrase: null,
    cachedKeyId: null,
  });
  if (contentTab?.id) {
    chrome.tabs.sendMessage(contentTab.id, { action: "stopCapture" });
  }
  chrome.runtime.sendMessage({ action: "stopImport" });

  // https://stackoverflow.com/a/56483156
  return true;
});

async function getCapture(tab: chrome.tabs.Tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  return dataUrl;
}

async function getTotp(text: string, silent = false) {
  if (!contentTab || !contentTab.id || !text) {
    return false;
  }
  const id = contentTab.id;

  if (text.indexOf("otpauth://") !== 0) {
    if (text.indexOf("otpauth-migration://") === 0) {
      const otpUrls = getOTPAuthPerLineFromOPTAuthMigration(text);
      if (otpUrls.length === 0) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
        return false;
      }

      const getTotpPromises: Array<Promise<boolean>> = [];
      for (const otpUrl of otpUrls) {
        getTotpPromises.push(getTotp(otpUrl, true));
      }

      const getTotpResults = await Promise.allSettled(getTotpPromises);
      const failedCount = getTotpResults.filter((res) => !res).length;
      if (failedCount === otpUrls.length) {
        !silent && chrome.tabs.sendMessage(id, { action: "migrationfail" });
        return false;
      }

      if (failedCount > 0) {
        !silent &&
          chrome.tabs.sendMessage(id, { action: "migrationpartlyfail" });
        return true;
      }

      !silent && chrome.tabs.sendMessage(id, { action: "migrationsuccess" });
      return true;
    } else if (text === "error decoding QR Code") {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      !silent && chrome.tabs.sendMessage(id, { action: "text", text });
      return true;
    }
  } else {
    let uri = text.split("otpauth://")[1];
    let type = uri.substr(0, 4).toLowerCase();
    uri = uri.substr(5);
    let label = uri.split("?")[0];
    const parameterPart = uri.split("?")[1];
    if (!label || !parameterPart) {
      !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
      return false;
    } else {
      let secret = "";
      let account: string | undefined;
      let issuer: string | undefined;
      let algorithm: string | undefined;
      let period: number | undefined;
      let digits: number | undefined;

      try {
        label = decodeURIComponent(label);
      } catch (error) {
        console.error(error);
      }
      if (label.indexOf(":") !== -1) {
        issuer = label.split(":")[0];
        account = label.split(":")[1];
      } else {
        account = label;
      }
      const parameters = parameterPart.split("&");
      const {
        cachedPassphrase,
        cachedKeyId,
      } = await chrome.storage.session.get();
      parameters.forEach((item) => {
        const parameter = item.split("=");
        if (parameter[0].toLowerCase() === "secret") {
          secret = parameter[1];
        } else if (parameter[0].toLowerCase() === "issuer") {
          try {
            issuer = decodeURIComponent(parameter[1]);
          } catch {
            issuer = parameter[1];
          }
          issuer = issuer.replace(/\+/g, " ");
        } else if (parameter[0].toLowerCase() === "counter") {
          // let counter = Number(parameter[1]);
          // counter = isNaN(counter) || counter < 0 ? 0 : counter;
        } else if (parameter[0].toLowerCase() === "period") {
          period = Number(parameter[1]);
          period =
            isNaN(period) || period < 0 || period > 60 || 60 % period !== 0
              ? undefined
              : period;
        } else if (parameter[0].toLowerCase() === "digits") {
          digits = Number(parameter[1]);
          digits = isNaN(digits) || digits === 0 ? 6 : digits;
        } else if (parameter[0].toLowerCase() === "algorithm") {
          algorithm = parameter[1];
        }
      });

      if (!secret) {
        !silent && chrome.tabs.sendMessage(id, { action: "errorqr" });
        return false;
      } else if (
        !/^[0-9a-f]+$/i.test(secret) &&
        !/^[2-7a-z]+=*$/i.test(secret)
      ) {
        !silent && chrome.tabs.sendMessage(id, { action: "secretqr", secret });
        return false;
      } else {
        const encryption = new Encryption(cachedPassphrase, cachedKeyId);
        const hash = crypto.randomUUID();
        if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "totp"
        ) {
          type = "hex";
        } else if (
          !/^[2-7a-z]+=*$/i.test(secret) &&
          /^[0-9a-f]+$/i.test(secret) &&
          type === "hotp"
        ) {
          type = "hhex";
        }
        const entryData: { [hash: string]: RawOTPStorage } = {};
        entryData[hash] = {
          account,
          hash,
          issuer,
          secret,
          type,
          encrypted: false,
          index: 0,
          counter: 0,
          pinned: false,
        };
        if (period) {
          entryData[hash].period = period;
        }
        if (digits) {
          entryData[hash].digits = digits;
        }
        if (algorithm) {
          entryData[hash].algorithm = algorithm;
        }
        if (
          // If the entries are encrypted and we aren't unlocked, error.
          (await EntryStorage.hasEncryptionKey()) !==
          encryption.getEncryptionStatus()
        ) {
          !silent && chrome.tabs.sendMessage(id, { action: "errorenc" });
          return false;
        }
        await EntryStorage.import(encryption, entryData);
        !silent && chrome.tabs.sendMessage(id, { action: "added", account });
        return true;
      }
    }
  }
}

chrome.commands.onCommand.addListener(async (command: string) => {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();

  let tab: chrome.tabs.Tab | undefined;

  switch (command) {
    case "scan-qr":
      if (cachedPassphrase === null || cachedPassphrase === undefined) {
        return;
      }

      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;
        chrome.tabs.sendMessage(tab.id, { action: "capture" });
      }
      break;

    case "autofill":
      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;

        const siteName = await getSiteName();
        const entries = await EntryStorage.get();
        const matchedEntries = getMatchedEntries(siteName, entries);

        if (matchedEntries && matchedEntries.length === 1) {
          const entry = matchedEntries[0];
          const encryption = new Encryption(cachedPassphrase, cachedKeyId);
          entry.applyEncryption(encryption);

          if (
            entry.code !== CodeState.Encrypted &&
            entry.code !== CodeState.Invalid
          ) {
            chrome.tabs.sendMessage(tab.id, {
              action: "pastecode",
              code: matchedEntries[0].code,
            });
          }
        }
      }
      break;

    default:
      break;
  }

  // https://stackoverflow.com/a/56483156
  return true;
});

async function setAutolock() {
  const enforcedAutolock = Number(
    await ManagedStorage.get("enforceAutolock", false)
  );

  if (enforcedAutolock && enforcedAutolock > 0) {
    chrome.alarms.create("autolock", { delayInMinutes: enforcedAutolock });
    return;
  }

  // Set default autolock value
  if (UserSettings.items.autolock === undefined) {
    UserSettings.items.autolock = 30;
  }

  if (Number(UserSettings.items.autolock) > 0) {
    chrome.alarms.create("autolock", {
      delayInMinutes: Number(UserSettings.items.autolock),
    });
  }
}

async function updateContextMenu() {
  chrome.permissions.contains(
    {
      permissions: ["contextMenus"],
    },
    (result) => {
      if (result) {
        if (UserSettings.items.enableContextMenu === true) {
          chrome.contextMenus.removeAll();
          chrome.contextMenus.create({
            id: "otpContextMenu",
            title: chrome.i18n.getMessage("extName"),
            contexts: ["all"],
          });
          chrome.contextMenus.onClicked.addListener((_info, tab) => {
            let popupUrl = "view/popup.html?popup=true";
            if (tab && tab.url && tab.title) {
              popupUrl +=
                "&url=" +
                encodeURIComponent(tab.url) +
                "&title=" +
                encodeURIComponent(tab.title);
            }
            let windowType;
            if (isFirefox) {
              windowType = "detached_panel";
            } else {
              windowType = "panel";
            }
            chrome.windows.create({
              url: chrome.runtime.getURL(popupUrl),
              type: windowType as chrome.windows.createTypeEnum,
              height: POPUP_HEIGHT,
              width: resolvePopupWidth(
                UserSettings.items.popupWidth,
                UserSettings.items.zoom
              ),
            });

            // https://stackoverflow.com/a/56483156
            return true;
          });
        } else {
          chrome.contextMenus.removeAll();
        }
      }
    }
  );
}

updateContextMenu();
