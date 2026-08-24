import "mocha";
import { assert } from "chai";
import { createLocalVue, shallowMount } from "@vue/test-utils";
import Vuex from "vuex";

import MainHeader from "../../../components/Popup/MainHeader.vue";

mocha.setup("bdd");

const localVue = createLocalVue();
localVue.use(Vuex);
localVue.prototype.i18n = {
  settings: "设置",
  lock: "锁定",
  add_secret: "手动输入",
  add_qr: "扫描二维码",
  edit: "编辑",
  extName: "身份验证器",
  github_sync_title: "GitHub 同步",
  github_state_historyRewritten: "需要修复",
};

describe("MainHeader GitHub sync button", () => {
  it("uses the same centered icon-button layout and opens SyncPage", async () => {
    const store = new Vuex.Store({
      modules: {
        style: {
          namespaced: true,
          state: { style: { isEditing: false } },
          mutations: { showInfo() {} },
        },
        accounts: {
          namespaced: true,
          state: { defaultEncryption: undefined },
        },
        sync: {
          namespaced: true,
          state: { configured: true, status: "historyRewritten" },
        },
        currentView: {
          namespaced: true,
          state: { currentView: "MainPage" },
          mutations: {
            changeView(state, page: string) {
              state.currentView = page;
            },
          },
        },
      },
    });
    const wrapper = shallowMount(MainHeader, {
      localVue,
      store,
      stubs: {
        IconCog: true,
        IconLock: true,
        IconSync: true,
        IconScan: true,
        IconPencil: true,
        IconCheck: true,
        IconPlus: true,
      },
    });

    const syncButton = wrapper.find("[data-test='sync-status']");
    assert.equal(syncButton.element.tagName, "BUTTON");
    assert.isTrue(syncButton.classes().includes("icon-button"));
    assert.equal(syncButton.attributes("aria-label"), "GitHub 同步: 需要修复");

    await syncButton.trigger("click");
    const state = store.state as unknown as {
      currentView: { currentView: string };
    };
    assert.equal(state.currentView.currentView, "SyncPage");
  });
});
