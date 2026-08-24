import "mocha";
import { assert } from "chai";

import {
  createEncryptedRepositoryConfig,
  createUnencryptedRepositoryConfig,
  parseRepositoryConfig,
  RepositoryConfig,
  repositoryConfigFingerprint,
  serializeRepositoryConfig,
  verifyRepositoryAccess,
} from "../../sync/RepositoryConfig";
import { unwrapDataKey } from "../../sync/SyncCrypto";

mocha.setup("bdd");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const kdf = {
  name: "argon2id" as const,
  salt: "AAECAwQFBgcICQoLDA0ODw==",
  time: 2,
  memoryKiB: 19456,
  parallelism: 1,
  hashLength: 32,
};

function bytes(value: number) {
  return new Uint8Array(32).fill(value);
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

describe("RepositoryConfig", () => {
  it("creates a canonical encrypted config and unwraps its data key", async () => {
    const kek = bytes(4);
    const dataKey = bytes(7);
    const result = await createEncryptedRepositoryConfig(kdf, kek, {
      repositoryId,
      createdAt: 123,
      dataKey,
      nonce: new Uint8Array(12).fill(9),
    });
    const serialized = serializeRepositoryConfig(result.config);
    const parsed = parseRepositoryConfig(serialized);

    assert.deepEqual(parsed, result.config);
    const access = await verifyRepositoryAccess(parsed, kek);
    assert.equal(access.mode, "aes-256-gcm");
    assert.deepEqual(Array.from(access.dataKey || []), Array.from(dataKey));

    assert.deepEqual(
      Array.from(
        await unwrapDataKey(
          {
            protocolVersion: 1,
            repositoryId,
            mode: "aes-256-gcm",
            kdf,
          },
          kek,
          parsed.encryption.mode === "aes-256-gcm"
            ? parsed.encryption.wrappedDataKey
            : { nonce: "", ciphertext: "" },
        ),
      ),
      Array.from(dataKey),
    );
    await assertRejects(verifyRepositoryAccess(parsed, bytes(9)));
  });

  it("creates a config without KDF material in plaintext mode", () => {
    const config: RepositoryConfig = createUnencryptedRepositoryConfig({
      repositoryId,
      createdAt: 123,
    });

    assert.deepEqual(config, {
      protocolVersion: 1,
      repositoryId,
      createdAt: 123,
      encryption: { mode: "none" },
    });
    assert.deepEqual(
      parseRepositoryConfig(serializeRepositoryConfig(config)),
      config,
    );
  });

  it("rejects malformed, weak, and non-canonical remote configs", () => {
    const config = createUnencryptedRepositoryConfig({
      repositoryId,
      createdAt: 123,
    });
    const parsed = JSON.parse(serializeRepositoryConfig(config));
    parsed.extra = true;

    assert.throws(() => parseRepositoryConfig(JSON.stringify(parsed)));
    assert.throws(() =>
      parseRepositoryConfig(
        JSON.stringify({
          ...config,
          repositoryId: "not-a-uuid",
        }),
      ),
    );
    const canonical = serializeRepositoryConfig(config);
    assert.deepEqual(parseRepositoryConfig(canonical + "\n"), config);
  });

  it("fingerprints the exact canonical repository identity", async () => {
    const first = createUnencryptedRepositoryConfig({
      repositoryId,
      createdAt: 123,
    });
    const second = createUnencryptedRepositoryConfig({
      repositoryId: "22222222-2222-4222-8222-222222222222",
      createdAt: 123,
    });

    assert.equal(
      await repositoryConfigFingerprint(first),
      await repositoryConfigFingerprint(first),
    );
    assert.notEqual(
      await repositoryConfigFingerprint(first),
      await repositoryConfigFingerprint(second),
    );
  });

  it("fails to create an encrypted config with a weak KDF", async () => {
    await assertRejects(
      createEncryptedRepositoryConfig({ ...kdf, memoryKiB: 8192 }, bytes(1), {
        repositoryId,
        dataKey: bytes(2),
      }),
    );
  });
});
