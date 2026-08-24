import "mocha";
import { assert } from "chai";

import { decodeBase64, encodeBase64 } from "../../sync/Base64";

mocha.setup("bdd");

describe("Base64", () => {
  it("matches standard vectors and round-trips binary lengths", () => {
    assert.equal(encodeBase64(new Uint8Array([102])), "Zg==");
    assert.equal(encodeBase64(new Uint8Array([102, 111])), "Zm8=");
    assert.equal(encodeBase64(new Uint8Array([102, 111, 111])), "Zm9v");

    for (let length = 1; length <= 32; length += 1) {
      const input = Uint8Array.from({ length }, (_, index) => index * 7);
      assert.deepEqual(
        Array.from(decodeBase64(encodeBase64(input))),
        Array.from(input),
      );
    }
  });

  it("rejects malformed and non-canonical encodings", () => {
    assert.throws(() => decodeBase64(""));
    assert.throws(() => decodeBase64("abc"));
    assert.throws(() => decodeBase64("A==="));
    assert.throws(() => decodeBase64("Zh=="));
    assert.throws(() => decodeBase64("Zm9="));
  });
});
