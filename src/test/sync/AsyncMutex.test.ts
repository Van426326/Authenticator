import "mocha";
import { assert } from "chai";

import { AsyncMutex, AsyncMutexPermit } from "../../sync/AsyncMutex";

mocha.setup("bdd");

describe("AsyncMutex", () => {
  it("serializes concurrent operations and continues after failure", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    const first = mutex.runExclusive(async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      throw new Error("expected failure");
    });
    const second = mutex.runExclusive(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await first.catch(() => undefined);
    await second;

    assert.deepEqual(events, [
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("allows a holder to re-enter with its permit", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    await mutex.runExclusive(async (permit: AsyncMutexPermit) => {
      events.push("outer:start");
      await mutex.runExclusive(async () => {
        events.push("inner");
      }, permit);
      events.push("outer:end");
    });

    assert.deepEqual(events, ["outer:start", "inner", "outer:end"]);
  });
});
