<template>
  <div
    id="codes"
    v-bind:class="{ filter: shouldFilter && filter, search: showSearch }"
  >
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
        <p>
          {{ i18n.no_entires }}
          <a href="#" v-on:click="openLink('https://otp.ee/quickstart')">{{
            i18n.learn_more
          }}</a>
        </p>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { mapState, mapGetters } from "vuex";
import { OTPEntry } from "../../models/otp";
import { EntryStorage } from "../../models/storage";

import EntryComponent from "./EntryComponent.vue";

// import IconPlus from "../../../svg/plus.svg";
import IconKey from "../../../svg/key-solid.svg";

const stateComputed = {
  ...mapState("accounts", ["filter", "showSearch", "initComplete"]),
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
    openLink(url: string) {
      window.open(url, "_blank");
      return;
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
        .querySelector<HTMLLinkElement>(`.entry:nth-child(${nextIndex + 1})`)
        ?.focus();
    },
    focusLastEntry() {
      const lastIndex = this.entries.length - 1 - this.findNextEntryIndex(true);
      document
        .querySelector<HTMLLinkElement>(`.entry:nth-child(${lastIndex + 1})`)
        ?.focus();
    },
  },
  created() {
    // Don't drag if !isEditing
    this.$dragula.$service.options("entryDrake", {
      invalid: () => {
        if (!this.$store.state.style.style.isEditing) {
          return true;
        } else {
          return false;
        }
      },
    });

    // Update entry index if dragged
    this.$dragula.$service.eventBus.$on(
      "dropModel",
      async ({
        dragIndex,
        dropIndex,
      }: {
        dragIndex: number;
        dropIndex: number;
      }) => {
        this.$store.commit("accounts/moveCode", {
          from: dragIndex,
          to: dropIndex,
        });
        await EntryStorage.set(this.$store.state.accounts.entries);
      }
    );
  },
  components: {
    EntryComponent,
    // IconPlus,
    IconKey,
  },
});
</script>
