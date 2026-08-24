import "mocha";
import { assert } from "chai";

import {
  decodeRepositoryKekMessage,
  encodeRepositoryKekMessage,
} from "../../sync/SyncMessage";

mocha.setup("bdd");

describe("sync runtime message encoding", () => {
  it("preserves a repository KEK through Chrome JSON message serialization", () => {
    const kek = new Uint8Array(32).map((_, index) => index);
    const wireValue = JSON.parse(
      JSON.stringify(encodeRepositoryKekMessage(kek)),
    );

    assert.deepEqual(Array.from(decodeRepositoryKekMessage(wireValue)), [
      ...kek,
    ]);
  });

  it("rejects Chrome's lossy object serialization of a Uint8Array", () => {
    const lossyValue = JSON.parse(JSON.stringify(new Uint8Array(32)));
    assert.throws(() => decodeRepositoryKekMessage(lossyValue));
  });

  it("rejects malformed and incorrectly sized encoded keys", () => {
    assert.throws(() => decodeRepositoryKekMessage("not-base64"));
    assert.throws(() => decodeRepositoryKekMessage("AA=="));
  });
});
