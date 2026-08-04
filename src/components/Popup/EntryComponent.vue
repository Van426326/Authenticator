<template>
  <div
    v-bind:role="style.isEditing ? undefined : 'button'"
    data-x-role="entry"
    v-bind:data-entry-hash="entry.hash"
    v-bind:tabindex="style.isEditing ? -1 : tabindex"
    v-bind:aria-label="`${entry.issuer} ${entry.account}`"
    v-bind:class="{
      entry: true,
      pinnedEntry: entry.pinned,
      'no-copy': noCopy(entry.code),
    }"
    v-on:click="copyCode(entry)"
    v-on:keydown.enter="copyCode(entry)"
    v-on:keydown.space.prevent="copyCode(entry)"
  >
    <button
      class="deleteAction icon-button"
      type="button"
      v-bind:title="i18n.confirm_delete"
      v-bind:aria-label="i18n.confirm_delete"
      v-on:click.stop="removeEntry(entry)"
    >
      <IconMinusCircle />
    </button>
    <div
      class="sector"
      v-if="entry.type !== OTPType.hotp && entry.type !== OTPType.hhex"
      v-show="sectorStart"
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16">
        <circle
          cx="8"
          cy="8"
          r="4"
          v-bind:style="{
            animationDuration: entry.period + 's',
            animationDelay: (sectorOffset % entry.period) + 's',
          }"
        />
      </svg>
    </div>
    <button
      v-bind:class="{ counter: true, disabled: style.hotpDisabled }"
      v-if="entry.type === OTPType.hotp || entry.type === OTPType.hhex"
      type="button"
      v-bind:title="i18n.update"
      v-bind:aria-label="i18n.update"
      v-bind:disabled="style.hotpDisabled"
      v-on:click.stop="nextCode(entry)"
    >
      <IconRedo />
    </button>
    <div class="issuer">
      {{
        entry.issuer.split("::")[0] +
        (theme === "compact" ? ` (${entry.account})` : "")
      }}
    </div>
    <div class="issuerEdit">
      <input
        v-bind:placeholder="i18n.issuer"
        v-bind:aria-label="i18n.issuer"
        type="text"
        v-model="entry.issuer"
        v-on:change="entry.update(encryption)"
      />
    </div>
    <div
      v-bind:class="{
        code: true,
        hotp: entry.type === OTPType.hotp || entry.type === OTPType.hhex,
        timeout: entry.period - (second % entry.period) < 5,
      }"
      v-html="style.isEditing ? showBulls(entry) : showCode(entry.code)"
    ></div>
    <div class="issuer account">{{ entry.account }}</div>
    <div class="issuerEdit">
      <input
        v-bind:placeholder="i18n.accountName"
        v-bind:aria-label="i18n.accountName"
        type="text"
        v-model="entry.account"
        v-on:change="entry.update(encryption)"
      />
    </div>
    <button
      class="showqr icon-button"
      type="button"
      v-bind:title="i18n.add_qr"
      v-bind:aria-label="i18n.add_qr"
      v-if="shouldShowQrIcon(entry)"
      v-on:click.stop="showQr(entry)"
    >
      <IconQr />
    </button>
    <button
      class="pin icon-button"
      type="button"
      v-bind:title="i18n.edit"
      v-bind:aria-label="i18n.edit"
      v-on:click.stop="pin(entry)"
    >
      <IconPin />
    </button>
    <button
      class="movehandle icon-button"
      type="button"
      v-bind:title="i18n.drag_to_reorder"
      v-bind:aria-label="i18n.drag_to_reorder"
      v-on:click.stop
    >
      <IconBars />
    </button>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { mapState } from "vuex";
import * as QRGen from "qrcode-generator";
import { OTPEntry, OTPType, CodeState, OTPAlgorithm } from "../../models/otp";
import { EntryStorage } from "../../models/storage";
import { getCurrentTab, okToInjectContentScript } from "../../utils";

import IconMinusCircle from "../../../svg/minus-circle.svg";
import IconRedo from "../../../svg/redo.svg";
import IconQr from "../../../svg/qrcode.svg";
import IconBars from "../../../svg/bars.svg";
import IconPin from "../../../svg/pin.svg";

const computedPrototype = [
  mapState("accounts", [
    "OTPType",
    "sectorStart",
    "sectorOffset",
    "second",
    "encryption",
  ]),
  mapState("style", ["style"]),
  mapState("menu", ["theme"]),
];

let computed = {};

for (const module of computedPrototype) {
  Object.assign(computed, module);
}

export default Vue.extend({
  computed,
  props: {
    entry: OTPEntry,
    tabindex: Number,
  },
  methods: {
    noCopy(code: string) {
      return (
        code === CodeState.Encrypted ||
        code === CodeState.Invalid ||
        code.startsWith("&bull;")
      );
    },
    shouldShowQrIcon(entry: OTPEntry) {
      return (
        !this.$store.state.menu.exportDisabled &&
        entry.secret !== null &&
        entry.type !== OTPType.battle &&
        entry.type !== OTPType.steam
      );
    },
    showCode(code: string) {
      if (code === CodeState.Encrypted) {
        return this.i18n.encrypted;
      } else if (code === CodeState.Invalid) {
        return this.i18n.invalid;
      } else {
        return code;
      }
    },
    showBulls(entry: OTPEntry) {
      if (entry.code === CodeState.Encrypted) {
        return this.i18n.encrypted;
      } else if (entry.code === CodeState.Invalid) {
        return this.i18n.invalid;
      }

      if (entry.code.startsWith("&bull;")) {
        return entry.code;
      }

      return new Array(entry.digits).fill("&bull;").join("");
    },
    async removeEntry(entry: OTPEntry) {
      if (
        await this.$store.dispatch(
          "notification/confirm",
          this.i18n.confirm_delete
        )
      ) {
        await entry.delete();
        await this.$store.dispatch("accounts/deleteCode", entry.hash);
      }
      return;
    },
    async pin(entry: OTPEntry) {
      this.$store.commit("accounts/pinEntry", entry);
      await EntryStorage.set(this.$store.state.accounts.entries);
      const codesEl = document.getElementById("codes") as HTMLDivElement;
      codesEl.scrollTop = 0;
    },
    showQr(entry: OTPEntry) {
      this.$store.commit("qr/setQr", getQrUrl(entry));
      this.$store.commit("style/showQr");
      return;
    },
    async nextCode(entry: OTPEntry) {
      if (this.$store.state.style.hotpDisabled) {
        return;
      }
      this.$store.commit("style/toggleHotpDisabled");
      await entry.next();
      setTimeout(() => {
        this.$store.commit("style/toggleHotpDisabled");
      }, 3000);
      return;
    },
    async copyCode(entry: OTPEntry) {
      if (
        this.$store.state.style.style.isEditing ||
        entry.code === CodeState.Invalid ||
        entry.code.startsWith("&bull;")
      ) {
        return;
      }

      if (entry.code === CodeState.Encrypted) {
        this.$store.commit("style/showInfo", true);
        this.$store.commit("currentView/changeView", "EnterPasswordPage");
        return;
      }

      chrome.permissions.request(
        { permissions: ["clipboardWrite"] },
        async (granted) => {
          if (granted) {
            const codeClipboard = document.getElementById(
              "codeClipboard"
            ) as HTMLInputElement;
            if (!codeClipboard) {
              return;
            }

            if (this.$store.state.menu.useAutofill) {
              await insertContentScript();
              const tab = await getCurrentTab();
              if (tab && tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  action: "pastecode",
                  code: entry.code,
                });
              }
            }

            const lastActiveElement = document.activeElement as HTMLElement;
            codeClipboard.value = entry.code;
            codeClipboard.focus();
            codeClipboard.select();
            document.execCommand("Copy");
            lastActiveElement.focus();
            this.$store.dispatch(
              "notification/ephermalMessage",
              this.i18n.copied
            );
          }
        }
      );

      return;
    },
  },
  components: {
    IconMinusCircle,
    IconRedo,
    IconQr,
    IconBars,
    IconPin,
  },
});

// TODO: move most of this to a models file and reuse for backup stuff
function getQrUrl(entry: OTPEntry) {
  const label = entry.issuer
    ? entry.issuer + ":" + entry.account
    : entry.account;
  const type =
    entry.type === OTPType.hex
      ? OTPType[OTPType.totp]
      : entry.type === OTPType.hhex
      ? OTPType[OTPType.hotp]
      : OTPType[entry.type];
  const otpauth =
    "otpauth://" +
    type +
    "/" +
    encodeURIComponent(label) +
    "?secret=" +
    entry.secret +
    (entry.issuer
      ? "&issuer=" + encodeURIComponent(entry.issuer.split("::")[0])
      : "") +
    (entry.type === OTPType.hotp || entry.type === OTPType.hhex
      ? "&counter=" + entry.counter
      : "") +
    (entry.type === OTPType.totp && entry.period !== 30
      ? "&period=" + entry.period
      : "") +
    (entry.digits !== 6 ? "&digits=" + entry.digits : "") +
    (entry.algorithm !== OTPAlgorithm.SHA1
      ? "&algorithm=" + OTPAlgorithm[entry.algorithm]
      : "");
  const qr = QRGen(0, "L");
  qr.addData(otpauth);
  qr.make();
  return qr.createDataURL(5);
}

async function insertContentScript() {
  let tab = await getCurrentTab();
  if (okToInjectContentScript(tab)) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["/dist/content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["/css/content.css"],
    });
  }
}
</script>
