import "mocha";
import { assert } from "chai";
import chrome from "sinon-chrome";
import { Sync } from "../../store/Sync";

mocha.setup("bdd");

describe("Sync store", () => {
  beforeEach(() => {
    chrome.storage.local.get.reset();
    global.chrome.storage.local.get = chrome.storage.local.get;
  });

  it("loads persisted GitHub status and connection state", async () => {
    chrome.storage.local.get.resolves({
      githubSyncStatus: {
        status: "conflict",
        updatedAt: 10,
        lastSuccessfulSyncAt: 8,
      },
      githubSyncConnection: { repositoryId: "repository" },
    });

    const module = await new Sync().getModule();

    assert.deepEqual(module.state, {
      status: "conflict",
      updatedAt: 10,
      lastSuccessfulSyncAt: 8,
      configured: true,
    });
  });

  it("updates status broadcasts without flipping configured off a stored connection", async () => {
    chrome.storage.local.get.resolves({
      githubSyncConnection: { repositoryId: "repository" },
    });
    const module = await new Sync().getModule();

    module.mutations.setStatus(module.state, {
      status: "unconfigured",
      updatedAt: 20,
    });

    assert.deepEqual(module.state, {
      status: "unconfigured",
      updatedAt: 20,
      lastSuccessfulSyncAt: undefined,
      configured: true,
    });
  });

  it("does not infer configured from a status broadcast when no connection exists", async () => {
    chrome.storage.local.get.resolves({});
    const module = await new Sync().getModule();

    module.mutations.setStatus(module.state, {
      status: "synced",
      updatedAt: 20,
      lastSuccessfulSyncAt: 20,
    });

    assert.deepEqual(module.state, {
      status: "synced",
      updatedAt: 20,
      lastSuccessfulSyncAt: 20,
      configured: false,
    });
  });

  it("updates configured only through the explicit connection mutation", async () => {
    chrome.storage.local.get.resolves({});
    const module = await new Sync().getModule();

    module.mutations.setConfigured(module.state, true);
    assert.isTrue(module.state.configured);
    module.mutations.setConfigured(module.state, false);
    assert.isFalse(module.state.configured);
  });
});
