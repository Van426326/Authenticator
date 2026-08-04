<template>
  <div>
    <div class="header">
      <span id="menuName">{{ i18n.settings }}</span>
      <button
        class="icon icon-button"
        id="i-close"
        type="button"
        v-bind:title="i18n.close"
        v-bind:aria-label="i18n.close"
        v-on:click="hideMenu()"
      >
        <IconArrowLeft />
      </button>
    </div>
    <div id="menuBody">
      <div class="menuList">
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.advisor"
          v-on:click="showInfo('AdvisorPage')"
        >
          <span><IconAdvisor /></span>{{ i18n.advisor }}
        </button>
        <a
          class="menuItem"
          href="permissions.html"
          target="_blank"
          v-bind:title="i18n.permissions"
        >
          <span><IconClipboardCheck /></span>{{ i18n.permissions }}
        </a>
      </div>
      <div class="menuList">
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.backup"
          v-on:click="showInfo('BackupPage')"
        >
          <span><IconExchange /></span>{{ i18n.backup }}
        </button>
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.security"
          v-on:click="showInfo('SetPasswordPage')"
        >
          <span><IconLock /></span>{{ i18n.security }}
        </button>
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.sync_clock"
          v-on:click="syncClock()"
          v-if="isSupported"
        >
          <span><IconSync /></span>{{ i18n.sync_clock }}
        </button>
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.resize_popup_page"
          v-on:click="showInfo('PreferencesPage')"
        >
          <span><IconWrench /></span>{{ i18n.resize_popup_page }}
        </button>
      </div>
      <div class="menuList">
        <button
          class="menuItem"
          data-test="feedback"
          type="button"
          v-bind:title="i18n.feedback"
          v-on:click="openHelp()"
        >
          <span><IconComments /></span>{{ i18n.feedback }}
        </button>
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.translate"
          v-on:click="openLink('https://otp.ee/translate')"
        >
          <span><IconGlobe /></span>{{ i18n.translate }}
        </button>
        <button
          class="menuItem"
          type="button"
          v-bind:title="i18n.source"
          v-on:click="openLink('https://otp.ee/sourcecode')"
        >
          <span><IconCode /></span>{{ i18n.source }}
        </button>
        <a
          class="menuItem"
          href="licenses.html"
          target="_blank"
          v-bind:title="i18n.about"
        >
          <span><IconInfo /></span>{{ i18n.about }}
        </a>
      </div>
      <div id="version">Version {{ version }}</div>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { syncTimeWithGoogle } from "../../syncTime";

import IconArrowLeft from "../../../svg/arrow-left.svg";
import IconInfo from "../../../svg/info.svg";
import IconExchange from "../../../svg/exchange.svg";
import IconDatabase from "../../../svg/database.svg";
import IconLock from "../../../svg/lock.svg";
import IconSync from "../../../svg/sync.svg";
import IconWrench from "../../../svg/wrench.svg";
import IconAdvisor from "../../../svg/lightbulb.svg";
import IconComments from "../../../svg/comments.svg";
import IconGlobe from "../../../svg/globe.svg";
import IconCode from "../../../svg/code.svg";
import IconClipboardCheck from "../../../svg/clipboard-check.svg";
import { isFirefox, isSafari } from "../../browser";
import { UserSettings } from "../../models/settings";

export default Vue.extend({
  components: {
    IconArrowLeft,
    IconInfo,
    IconExchange,
    IconDatabase,
    IconLock,
    IconSync,
    IconWrench,
    IconAdvisor,
    IconComments,
    IconGlobe,
    IconCode,
    IconClipboardCheck,
  },
  computed: {
    version: function () {
      return this.$store.state.menu.version;
    },
    isSupported: {
      get(): boolean {
        return !isSafari;
      },
    },
  },
  methods: {
    hideMenu() {
      this.$store.commit("style/hideMenu");
    },
    openHelp() {
      let url = "https://otp.ee/chromeissues";

      if (navigator.userAgent.indexOf("Firefox") !== -1) {
        url = "https://otp.ee/firefoxissues";
      } else if (navigator.userAgent.indexOf("Edg") !== -1) {
        url = "https://otp.ee/edgeissues";
      }

      const feedbackURL = this.$store.state.menu.feedbackURL;
      if (typeof feedbackURL === "string" && feedbackURL) {
        url = feedbackURL;
      }

      chrome.tabs.create({ url });
    },
    openLink(url: string) {
      window.open(url, "_blank");
      return;
    },
    showInfo(tab: string) {
      if (this.$store.getters["accounts/currentlyEncrypted"]) {
        if (tab === "SetPasswordPage") {
          this.$store.commit("notification/alert", this.i18n.phrase_incorrect);
          return;
        }
      }
      this.$store.commit("style/showInfo");
      this.$store.commit("currentView/changeView", tab);
      return;
    },
    syncClock() {
      chrome.permissions.request(
        { origins: ["https://www.google.com/"] },
        async (granted) => {
          if (granted) {
            await UserSettings.updateItems();
            const message = await syncTimeWithGoogle();
            this.$store.commit("notification/alert", this.i18n[message]);
          }
          return;
        }
      );
      return;
    },
  },
});
</script>
