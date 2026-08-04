import { isSafari } from "../browser";
import { PopupWidth, resolvePopupWidth } from "../models/display";
import { UserSettings } from "../models/settings";
import { ManagedStorage } from "../models/storage";

export class Menu implements Module {
  async getModule() {
    await UserSettings.updateItems();

    const popupWidth = resolvePopupWidth(
      UserSettings.items.popupWidth,
      UserSettings.items.zoom
    );
    if (UserSettings.items.popupWidth !== popupWidth) {
      UserSettings.items.popupWidth = popupWidth;
      UserSettings.items.zoom = undefined;
      await UserSettings.commitItems();
    }

    const menuState = {
      state: {
        version: chrome.runtime.getManifest()?.version || "0.0.0",
        popupWidth,
        useAutofill: UserSettings.items.autofill === true,
        smartFilter: UserSettings.items.smartFilter === true,
        enableContextMenu: UserSettings.items.enableContextMenu === true,
        theme: UserSettings.items.theme || (isSafari ? "flat" : "normal"),
        autolock: Number(UserSettings.items.autolock) || 30,
        backupDisabled: await ManagedStorage.get("disableBackup", false),
        exportDisabled: await ManagedStorage.get("disableExport", false),
        enforcePassword: await ManagedStorage.get("enforcePassword", false),
        enforceAutolock: await ManagedStorage.get("enforceAutolock", false),
        storageArea: await ManagedStorage.get<"sync" | "local">("storageArea"),
        feedbackURL: await ManagedStorage.get<string>("feedbackURL"),
        passwordPolicy: await ManagedStorage.get<string>("passwordPolicy"),
        passwordPolicyHint: await ManagedStorage.get<string>(
          "passwordPolicyHint"
        ),
      },
      mutations: {
        setPopupWidth: (state: MenuState, width: PopupWidth) => {
          const popupWidth = resolvePopupWidth(width);
          state.popupWidth = popupWidth;
          UserSettings.items.popupWidth = popupWidth;
          UserSettings.items.zoom = undefined;
          UserSettings.commitItems();
          this.applyPopupWidth(popupWidth);
        },
        setAutofill(state: MenuState, useAutofill: boolean) {
          state.useAutofill = useAutofill;
          UserSettings.items.autofill = useAutofill;
          UserSettings.commitItems();
        },
        setSmartFilter(state: MenuState, smartFilter: boolean) {
          state.smartFilter = smartFilter;
          UserSettings.items.smartFilter = smartFilter;
          UserSettings.commitItems();
        },
        setEnableContextMenu(state: MenuState, enableContextMenu: boolean) {
          state.enableContextMenu = enableContextMenu;
          UserSettings.items.enableContextMenu = enableContextMenu;
          UserSettings.commitItems();
        },
        setTheme(state: MenuState, theme: string) {
          state.theme = theme;
          UserSettings.items.theme = theme;
          UserSettings.commitItems();
        },
        setAutolock(state: MenuState, autolock: number) {
          state.autolock = autolock;
          UserSettings.items.autolock = autolock;
          UserSettings.commitItems();
        },
      },
      namespaced: true,
    };

    this.applyPopupWidth(menuState.state.popupWidth);

    return menuState;
  }

  private applyPopupWidth(width: PopupWidth) {
    document.documentElement.style.setProperty("--popup-width", `${width}px`);
    document.body.style.width = `${width}px`;
    document.body.style.marginBottom = "";
    document.body.style.marginRight = "";
    document.body.style.transform = "";

    const query = new URLSearchParams(window.location.search);
    if (query.get("popup")) {
      chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, {
        width: width + (window.outerWidth - window.innerWidth),
      });
    }
  }
}
