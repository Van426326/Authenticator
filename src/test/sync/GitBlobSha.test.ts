import "mocha";
import { assert } from "chai";

import { gitBlobSha } from "../../sync/github/GitBlobSha";

mocha.setup("bdd");

describe("gitBlobSha", () => {
  it("matches known Git blob object hashes", async () => {
    assert.equal(
      await gitBlobSha(new TextEncoder().encode("test\n")),
      "9daeafb9864cf43055ae93beb0afd6c7d144bfa4",
    );
    assert.equal(
      await gitBlobSha(new TextEncoder().encode("hello")),
      "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
    );
  });

  it("distinguishes content from size and produces lowercase hex", async () => {
    const first = await gitBlobSha(new TextEncoder().encode("abc"));
    const second = await gitBlobSha(new TextEncoder().encode("abcd"));
    assert.notEqual(first, second);
    assert.match(first, /^[0-9a-f]{40}$/);
  });
});