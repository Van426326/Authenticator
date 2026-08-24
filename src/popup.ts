// Vue
import Vue from "vue";
import Vuex from "vuex";
import { Vue2Dragula } from "vue2-dragula";

// Components
import Popup from "./components/Popup.vue";
import CommonComponents from "./components/common/index";

// Other
import { loadI18nMessages } from "./store/i18n";
import { Style } from "./store/Style";
import { Accounts } from "./store/Accounts";
import { Sync } from "./store/Sync";
import { CurrentView } from "./store/CurrentView";
import { Menu } from "./store/Menu";
import { Notification } from "./store/Notification";
import { Qr } from "./store/Qr";
import { Advisor } from "./store/Advisor";
import { syncTimeWithGoogle } from "./syncTime";
import { POPUP_HEIGHT, resolvePopupWidth } from "./models/display";
import { StorageLocation, UserSettings } from "./models/settings";
import { triggerGithubPopupSync } from "./sync/githubSyncUi";

async function migrateLocalStorageToBrowserStorage() {
  if (localStorage.length > 0) {
    const location =
      (localStorage.storageLocation as StorageLocation) || StorageLocation.Sync;
    await UserSettings.convertFromLocalStorage(localStorage, location);
    localStorage.clear();
  }
}

async function init() {
  await migrateLocalStorageToBrowserStorage();
  await UserSettings.removeLegacyCloudSettings();
  await UserSettings.updateItems();
  // A cold service worker may need a full network sync. Never block the first
  // Vue render on that work: status updates arrive through runtime messages.
  triggerGithubPopupSync((message) => chrome.runtime.sendMessage(message));

  // Add globals
  Vue.prototype.i18n = await loadI18nMessages();

  // Load modules
  Vue.use(Vuex);
  Vue.use(Vue2Dragula);

  // Load common components globally
  for (const component of CommonComponents) {
    Vue.component(component.name, component.component);
  }

  // State
  const store = new Vuex.Store({
    modules: {
      accounts: await new Accounts().getModule(),
      advisor: await new Advisor().getModule(),
      sync: await new Sync().getModule(),
      currentView: new CurrentView().getModule(),
      menu: await new Menu().getModule(),
      notification: new Notification().getModule(),
      qr: new Qr().getModule(),
      style: new Style().getModule(),
    },
  });

  // Render
  const instance = new Vue({
    render: (h) => h(Popup),
    store,
    mounted() {
      // Update time based entries' codes
      this.$store.commit("accounts/updateCodes");
      setInterval(() => {
        this.$store.commit("accounts/updateCodes");
      }, 1000);
    },
  }).$mount("#authenticator");

  // Prompt for password if needed
  if (instance.$store.state.accounts.shouldShowPassphrase) {
    // If we have cached password, use that
    if (instance.$store.state.accounts.defaultEncryption) {
      instance.$store.commit("currentView/changeView", "LoadingPage");
      await instance.$store.dispatch("accounts/updateEntries");
    } else {
      instance.$store.commit("style/showInfo", true);
      instance.$store.commit("currentView/changeView", "EnterPasswordPage");
    }
  } else {
    // Set init complete if no encryption is present, otherwise this will be set in updateEntries.
    instance.$store.commit("accounts/initComplete");
  }

  // Auto focus on first entry
  document.querySelector<HTMLAnchorElement>("a.entry[tabindex='0']")?.focus();

  // Set document title
  try {
    document.title = instance.i18n.extName;
  } catch (e) {
    console.error(e);
  }

  // Warn if legacy password is set
  if (UserSettings.items.encodedPhrase) {
    instance.$store.commit(
      "notification/alert",
      instance.i18n.local_passphrase_warning
    );
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "githubSyncStatus" && message.status) {
      store.commit("sync/setStatus", message.status);
    }
  });

  // Open search if '/' is pressed
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "/") {
        if (instance.$store.getters["style/isMenuShown"]) {
          return;
        }
        instance.$store.commit("accounts/stopFilter");
        // It won't focus the texfield if vue unhides the div
        instance.$store.commit("accounts/showSearch");
        const searchDiv = document.getElementById("search");
        const searchInput = document.getElementById("searchInput");
        if (!searchInput || !searchDiv) {
          return;
        }
        searchDiv.style.display = "block";
        searchInput.focus();
      }
    },
    false
  );

  // Show search box if more than 10 entries
  if (
    instance.$store.state.accounts.entries.length >= 10 &&
    !(
      instance.$store.getters["accounts/shouldFilter"] &&
      instance.$store.state.accounts.filter
    )
  ) {
    instance.$store.commit("accounts/showSearch");
  }

  const query = new URLSearchParams(document.location.search.substring(1));
  // Resize window to proper size if popup
  if (query.get("popup")) {
    const popupWidth = resolvePopupWidth(
      UserSettings.items.popupWidth,
      UserSettings.items.zoom
    );
    if (
      window.innerHeight !== POPUP_HEIGHT ||
      window.innerWidth !== popupWidth
    ) {
      const adjustedHeight =
        POPUP_HEIGHT + (window.outerHeight - window.innerHeight);
      const adjustedWidth =
        popupWidth + (window.outerWidth - window.innerWidth);
      chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, {
        height: adjustedHeight,
        width: adjustedWidth,
      });
    }
  }

  // TODO: give an option for this
  chrome.permissions.contains(
    { origins: ["https://www.google.com/"] },
    (hasPermission) => {
      if (hasPermission) {
        syncTimeWithGoogle();
      }
    }
  );
}

// GitHub synchronization is coordinated by the background runtime.
init();
