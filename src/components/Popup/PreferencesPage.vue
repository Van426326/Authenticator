<template>
  <div>
    <a-select-input
      :label="i18n.theme"
      v-model="theme"
      style="margin-left: 10px"
    >
      <option value="normal">{{ i18n.theme_light }}</option>
      <option value="dark">{{ i18n.theme_dark }}</option>
      <option value="simple">{{ i18n.theme_simple }}</option>
      <option value="compact">{{ i18n.theme_compact }}</option>
      <option value="accessibility">{{ i18n.theme_high_contrast }}</option>
      <option value="flat">{{ i18n.theme_flat }}</option>
    </a-select-input>
    <a-select-input
      :label="i18n.popup_width"
      v-model.number="popupWidth"
      style="margin-left: 10px"
    >
      <option :value="300">{{ i18n.width_narrow }}</option>
      <option :value="360">{{ i18n.width_default }}</option>
      <option :value="440">{{ i18n.width_wide }}</option>
    </a-select-input>
    <a-toggle-input :label="i18n.use_autofill" v-model="useAutofill" />
    <a-toggle-input
      :label="i18n.browser_sync"
      v-model="browserSync"
      :disabled="storageArea"
      @change="migrateStorage()"
    />
    <a-toggle-input :label="i18n.smart_filter" v-model="smartFilter" />
    <a-toggle-input
      :label="i18n.enable_context_menu"
      v-model="enableContextMenu"
      @change="requireContextMenuPermission()"
      v-if="isSupported"
    />
    <div class="control-group" v-show="!!defaultEncryption">
      <label class="combo-label">{{ i18n.autolock }}</label>
      <input
        class="input"
        type="number"
        min="0"
        style="width: 70px; text-align: center"
        v-model="autolock"
        :disabled="Boolean(enforceAutolock)"
      />
      <span class="combo-label" style="margin-left: 0; margin-right: 20px">{{
        i18n.minutes
      }}</span>
    </div>
    <a-button @click="popOut()">{{ i18n.popout }}</a-button>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { isFirefox, isSafari } from "../../browser";
import { UserSettings } from "../../models/settings";

export default Vue.extend({
  computed: {
    popupWidth: {
      get(): number {
        return this.$store.state.menu.popupWidth;
      },
      set(width: number) {
        this.$store.commit("menu/setPopupWidth", Number(width));
      },
    },
    useAutofill: {
      get(): boolean {
        return this.$store.state.menu.useAutofill;
      },
      set(useAutofill: boolean) {
        this.$store.commit("menu/setAutofill", useAutofill);
      },
    },
    smartFilter: {
      get(): boolean {
        return this.$store.state.menu.smartFilter;
      },
      set(smartFilter: boolean) {
        this.$store.commit("menu/setSmartFilter", smartFilter);
        this.$store.commit(
          "notification/alert",
          this.i18n.activate_auto_filter
        );
      },
    },
    enableContextMenu: {
      get(): boolean {
        return this.$store.state.menu.enableContextMenu;
      },
      set(enableContextMenu: boolean) {
        this.$store.commit("menu/setEnableContextMenu", enableContextMenu);
      },
    },
    theme: {
      get(): string {
        return this.$store.state.menu.theme;
      },
      set(theme: string) {
        this.$store.commit("menu/setTheme", theme);
      },
    },
    defaultEncryption(): string {
      return this.$store.state.accounts.defaultEncryption;
    },
    enforceAutolock() {
      return this.$store.state.menu.enforceAutolock;
    },
    autolock: {
      get(): number {
        if (this.$store.state.menu.enforceAutolock) {
          return this.$store.state.menu.enforceAutolock;
        } else {
          return this.$store.state.menu.autolock;
        }
      },
      set(autolock: number) {
        this.$store.commit("menu/setAutolock", autolock);
        chrome.runtime.sendMessage({ action: "resetAutolock" });
      },
    },
    storageArea() {
      return this.$store.state.menu.storageArea;
    },
    browserSync: {
      get(): boolean {
        return this.newStorageLocation === "sync";
      },
      set(value) {
        this.newStorageLocation = value ? "sync" : "local";
      },
    },
    isSupported: {
      get(): boolean {
        return !isFirefox && !isSafari;
      },
    },
  },
  data() {
    return {
      newStorageLocation: "",
    };
  },
  created() {
    UserSettings.updateItems().then(() => {
      this.newStorageLocation =
        this.$store.state.menu.storageArea ||
        UserSettings.items.storageLocation;
    });
  },
  methods: {
    popOut() {
      let windowType;
      if (isFirefox) {
        windowType = "detached_panel";
      } else {
        windowType = "panel";
      }
      chrome.windows.create({
        url: chrome.runtime.getURL("view/popup.html?popup=true"),
        type: windowType as chrome.windows.createTypeEnum,
        height: window.innerHeight,
        width: window.innerWidth,
      });
    },
    async migrateStorage() {
      this.$store.commit("currentView/changeView", "LoadingPage");
      try {
        const message = await this.$store.dispatch(
          "accounts/migrateStorage",
          this.newStorageLocation
        );
        this.$store.commit("notification/alert", this.i18n[message]);
      } catch (reason) {
        this.$store.commit(
          "notification/alert",
          `${this.i18n.updateFailure} ${String(reason)}`
        );
      } finally {
        this.$store.commit("currentView/changeView", "PreferencesPage");
      }
    },
    requireContextMenuPermission() {
      chrome.permissions.request(
        {
          permissions: ["contextMenus"],
        },
        (granted) => {
          if (!granted) {
            this.enableContextMenu = false;
            return;
          }
          chrome.runtime.sendMessage({
            action: "updateContextMenu",
          });
        }
      );
    },
  },
});
</script>
