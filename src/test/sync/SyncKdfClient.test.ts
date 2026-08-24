import "mocha";
import { assert } from "chai";

import { encodeBase64 } from "../../sync/Base64";
import {
  SandboxMessageHost,
  SandboxMessageTarget,
  SyncKdfClient as KdfClient,
} from "../../sync/SyncKdfClient";

mocha.setup("bdd");

const kdf = {
  name: "argon2id" as const,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  time: 2,
  memoryKiB: 19456,
  parallelism: 1,
  hashLength: 32,
};

class FakeHost implements SandboxMessageHost {
  listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  dispatch(source: MessageEventSource, data: unknown) {
    for (const listener of this.listeners) {
      listener({ source, data } as MessageEvent);
    }
  }
}

class FakeTarget implements SandboxMessageTarget {
  posted?: Record<string, unknown>;

  constructor(
    private readonly onPost: (message: Record<string, unknown>) => void,
  ) {}

  postMessage(message: unknown) {
    this.posted = message as Record<string, unknown>;
    this.onPost(this.posted);
  }
}

async function assertRejects(promise: Promise<unknown>) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, Error);
}

describe("SyncKdfClient", () => {
  it("derives a 32-byte KEK and correlates the sandbox response", async () => {
    const host = new FakeHost();
    let target: FakeTarget;
    target = new FakeTarget((message) => {
      queueMicrotask(() =>
        host.dispatch(target as unknown as MessageEventSource, {
          requestId: message.requestId,
          ok: true,
          key: encodeBase64(new Uint8Array(32).fill(7)),
        }),
      );
    });
    const client = new KdfClient(host, target, 1000);

    const key = await client.deriveKey("sync-password", kdf);

    assert.deepEqual(Array.from(key), Array(32).fill(7));
    assert.equal(target.posted?.action, "derive-sync-key");
    assert.equal(target.posted?.password, "sync-password");
    assert.equal(host.listeners.size, 0);
  });

  it("rejects sandbox failures and malformed keys", async () => {
    const host = new FakeHost();
    let target: FakeTarget;
    target = new FakeTarget((message) => {
      queueMicrotask(() =>
        host.dispatch(target as unknown as MessageEventSource, {
          requestId: message.requestId,
          ok: false,
          error: "derive failed",
        }),
      );
    });

    await assertRejects(
      new KdfClient(host, target, 1000).deriveKey("sync-password", kdf),
    );
    assert.equal(host.listeners.size, 0);
  });

  it("rejects unsafe KDF parameters before messaging the sandbox", async () => {
    const host = new FakeHost();
    const target = new FakeTarget(() => undefined);

    await assertRejects(
      new KdfClient(host, target, 1000).deriveKey("sync-password", {
        ...kdf,
        memoryKiB: 8192,
      }),
    );

    assert.isUndefined(target.posted);
  });
});
