<template>
  <div
    id="codes"
    v-bind:class="{ filter: shouldFilter && filter, search: showSearch }"
  >
    <div class="quick-settings" v-bind:aria-label="i18n.settings">
      <button
        class="theme-shortcut"
        type="button"
        v-bind:title="i18n.theme"
        v-bind:aria-label="i18n.theme"
        v-on:click="toggleTheme()"
      >
        <span class="theme-swatch" aria-hidden="true"></span>
        <span>{{ theme === "dark" ? i18n.theme_dark : i18n.theme_light }}</span>
      </button>
      <div
        class="width-presets"
        role="group"
        v-bind:aria-label="i18n.popup_width"
      >
        <button
          type="button"
          v-bind:class="{ active: popupWidth === 300 }"
          v-bind:aria-pressed="popupWidth === 300"
          v-on:click="setPopupWidth(300)"
        >
          {{ i18n.width_narrow }}
        </button>
        <button
          type="button"
          v-bind:class="{ active: popupWidth === 360 }"
          v-bind:aria-pressed="popupWidth === 360"
          v-on:click="setPopupWidth(360)"
        >
          {{ i18n.width_default }}
        </button>
        <button
          type="button"
          v-bind:class="{ active: popupWidth === 440 }"
          v-bind:aria-pressed="popupWidth === 440"
          v-on:click="setPopupWidth(440)"
        >
          {{ i18n.width_wide }}
        </button>
      </div>
    </div>
    <!-- Filter -->
    <button
      class="under-header"
      id="filter"
      type="button"
      v-on:click="clearFilter()"
    >
      {{ i18n.show_all_entries }}
    </button>
    <!-- Search -->
    <div class="under-header" id="search">
      <label class="visually-hidden" for="searchInput">{{ i18n.search }}</label>
      <input
        id="searchInput"
        v-model="searchText"
        v-bind:placeholder="i18n.search"
        v-bind:aria-label="i18n.search"
        type="search"
      />
      <div id="searchHint" v-if="searchText === ''" aria-hidden="true">
        <div></div>
        <div id="searchHintBorder">/</div>
        <div></div>
      </div>
    </div>
    <!-- Entries -->
    <div
      class="entries-list"
      v-dragula
      drake="entryDrake"
      v-on:keydown.down="focusNextEntry()"
      v-on:keydown.right="focusNextEntry()"
      v-on:keydown.up="focusLastEntry()"
      v-on:keydown.left="focusLastEntry()"
    >
      <EntryComponent
        v-for="entry in entries"
        :key="entry.hash"
        v-bind:filtered="!entry.pinned && !isMatchedEntry(entry)"
        v-bind:notSearched="!isSearchedEntry(entry)"
        v-bind:entry="entry"
        v-bind:tabindex="getTabindex(entry)"
      />
      <div
        class="no-entry"
        role="status"
        v-if="entries.length === 0 && initComplete"
      >
        <IconKey />
        <p>{{ i18n.no_entires }}</p>
        <button
          class="empty-primary-action"
          type="button"
          v-on:click="openManualEntry()"
        >
          {{ i18n.add_secret }}
        </button>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { mapState, mapGetters } from "vuex";
import { OTPEntry } from "../../models/otp";

import EntryComponent from "./EntryComponent.vue";

// import IconPlus from "../../../svg/plus.svg";
import IconKey from "../../../svg/key-solid.svg";

const stateComputed = {
  ...mapState("accounts", ["filter", "showSearch", "initComplete"]),
  ...mapState("menu", ["theme", "popupWidth"]),
  ...mapGetters("accounts", ["shouldFilter", "entries"]),
};

export default Vue.extend({
  data: function () {
    return {
      searchText: "",
    };
  },
  computed: {
    ...stateComputed,
    matchedEntryHashes(): Set<string> {
      return new Set(this.$store.getters["accounts/matchedEntries"]);
    },
    normalizedSearchText(): string {
      return this.searchText.trim().toLocaleLowerCase();
    },
    firstVisibleHash(): string {
      const firstEntry = this.entries.find((entry: OTPEntry) =>
        this.isEntryVisible(entry)
      );
      return firstEntry?.hash || "";
    },
  },
  methods: {
    openManualEntry() {
      if (
        this.$store.state.menu.enforcePassword &&
        !this.$store.state.accounts.defaultEncryption
      ) {
        this.$store.commit("style/showInfo");
        this.$store.commit("currentView/changeView", "SetPasswordPage");
        return;
      }
      if (this.$store.getters["accounts/currentlyEncrypted"]) {
        this.$store.commit("notification/alert", this.i18n.phrase_incorrect);
        return;
      }
      this.$store.commit("style/showInfo");
      this.$store.commit("currentView/changeView", "AddAccountPage");
    },
    toggleTheme() {
      this.$store.commit(
        "menu/setTheme",
        this.theme === "dark" ? "normal" : "dark"
      );
    },
    setPopupWidth(width: number) {
      this.$store.commit("menu/setPopupWidth", width);
    },

    isMatchedEntry(entry: OTPEntry) {
      return this.matchedEntryHashes.has(entry.hash);
    },
    isSearchedEntry(entry: OTPEntry) {
      if (!this.normalizedSearchText) {
        return true;
      }
      return (
        entry.issuer.toLocaleLowerCase().includes(this.normalizedSearchText) ||
        entry.account.toLocaleLowerCase().includes(this.normalizedSearchText)
      );
    },
    clearFilter() {
      this.$store.dispatch("accounts/clearFilter");
    },
    isEntryVisible(entry: OTPEntry) {
      return (
        this.isSearchedEntry(entry) &&
        (entry.pinned ||
          !this.shouldFilter ||
          !this.filter ||
          this.isMatchedEntry(entry))
      );
    },
    getTabindex(entry: OTPEntry) {
      return entry.hash === this.firstVisibleHash ? 0 : -1;
    },
    findNextEntryIndex(reverse: boolean) {
      if (document.activeElement?.getAttribute("data-x-role") !== "entry") {
        return -1;
      }

      const activeIndex = Array.prototype.indexOf.call(
        document.querySelectorAll(".entry"),
        document.activeElement
      );
      if (activeIndex === -1) {
        return -1;
      }

      // reverse modify origin array, and use slice() to make a clone first
      const _entries: OTPEntry[] = reverse
        ? this.entries.slice().reverse()
        : this.entries;

      let nextIndex = _entries.findIndex(
        (entry: OTPEntry, index: number) =>
          index >
            (reverse ? this.entries.length - 1 - activeIndex : activeIndex) &&
          this.isEntryVisible(entry)
      );

      if (nextIndex === -1) {
        nextIndex = _entries.findIndex((entry: OTPEntry) =>
          this.isEntryVisible(entry)
        );
      }

      return nextIndex;
    },
    focusNextEntry() {
      const nextIndex = this.findNextEntryIndex(false);
      document
        .querySelector<HTMLElement>(`.entry:nth-child(${nextIndex + 1})`)
        ?.focus();
    },
    focusLastEntry() {
      const lastIndex = this.entries.length - 1 - this.findNextEntryIndex(true);
      document
        .querySelector<HTMLElement>(`.entry:nth-child(${lastIndex + 1})`)
        ?.focus();
    },
    async handleDrop({ target }: { target?: Element }) {
      const container =
        target instanceof Element && target.classList.contains("entries-list")
          ? target
          : this.$el.querySelector(".entries-list");
      if (!container) {
        return;
      }

      const orderedHashes = Array.from(
        container.querySelectorAll<HTMLElement>(":scope > .entry")
      )
        .map((element) => element.dataset.entryHash)
        .filter((hash): hash is string => Boolean(hash));
      await this.$store.dispatch("accounts/reorderCodes", orderedHashes);
    },
  },
  created() {
    this.$dragula.$service.options("entryDrake", {
      moves: (_element: Element, _source: Element, handle: Element) =>
        Boolean(handle?.closest(".movehandle")),
    });
    this.$dragula.$service.eventBus.$on("dropModel", this.handleDrop);
  },
  beforeDestroy() {
    this.$dragula.$service.eventBus.$off("dropModel", this.handleDrop);
  },
  components: {
    EntryComponent,
    // IconPlus,
    IconKey,
  },
});
</script>
