<template>
  <main class="options-shell">
    <header class="options-header">
      <div class="options-brand" aria-hidden="true">A</div>
      <div>
        <p class="options-eyebrow">{{ i18n.extName }}</p>
        <h1>{{ i18n.settings }}</h1>
      </div>
    </header>

    <section class="danger-card" aria-labelledby="reset-title">
      <div class="danger-card__content">
        <p class="danger-card__label">{{ i18n.security }}</p>
        <h2 id="reset-title">{{ i18n.delete_all }}</h2>
        <p class="danger-card__warning">{{ i18n.delete_all_warning }}</p>

        <label class="confirm-control" for="delete-confirm">
          <input
            type="checkbox"
            id="delete-confirm"
            v-model="deleteConfirm"
            v-bind:disabled="deleteInProgress"
          />
          <span>{{ i18n.confirm_delete_all }}</span>
        </label>
      </div>

      <div class="danger-card__actions">
        <button
          class="danger-button"
          type="button"
          v-on:click="deleteEverything()"
          v-bind:disabled="!deleteConfirm || deleteInProgress"
        >
          {{ i18n.delete_all }}
        </button>
        <p
          class="options-status"
          role="status"
          aria-live="polite"
          v-show="statusMessage"
        >
          {{ statusMessage }}
        </p>
      </div>
    </section>
  </main>
</template>
<script lang="ts">
import Vue from "vue";

export default Vue.extend({
  data: function () {
    return {
      deleteConfirm: false,
      deleteInProgress: false,
      statusMessage: "",
    };
  },
  methods: {
    async deleteEverything() {
      if (!this.deleteConfirm || this.deleteInProgress) {
        return;
      }

      this.deleteInProgress = true;
      this.statusMessage = "";
      try {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        localStorage.clear();
        chrome.runtime.sendMessage({ action: "lock" });
        this.deleteConfirm = false;
        this.statusMessage = this.i18n.updateSuccess;
      } catch (error) {
        console.error("Failed to reset Authenticator", error);
        this.statusMessage = this.i18n.updateFailure;
      } finally {
        this.deleteInProgress = false;
      }
    },
  },
});
</script>
