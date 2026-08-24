import argon2 from "argon2-browser";
import { decodeBase64, encodeBase64 } from "./sync/Base64";
import { Argon2idKdfConfig, validateKdfConfig } from "./sync/SyncCrypto";

window.addEventListener("message", (event) => {
  const message = event.data;
  const source = event.source as Window;

  if (
    !source ||
    source !== window.parent ||
    !message ||
    typeof message !== "object"
  ) {
    return;
  }

  switch (message.action) {
    case "hash":
      Argon.hash(message.value, message.salt).then((hash) => {
        source.postMessage({ response: hash }, event.origin);
      });
      break;

    case "verify":
      Argon.compareHash(message.hash, message.value).then((result) => {
        source.postMessage({ response: result }, event.origin);
      });
      break;

    case "derive-sync-key":
      Argon.deriveSyncKey(message.password, message.kdf)
        .then((key) => {
          source.postMessage(
            {
              requestId: message.requestId,
              ok: true,
              key: encodeBase64(key),
            },
            event.origin
          );
        })
        .catch(() => {
          source.postMessage(
            {
              requestId: message.requestId,
              ok: false,
              error: "derive failed",
            },
            event.origin
          );
        });
      break;

    default:
      break;
  }
  return;
});

class Argon {
  static async hash(value: string, salt: string | Uint8Array) {
    const hash = await argon2.hash({
      pass: value,
      salt: salt,
      time: 2,
      mem: 1024 * 19,
      parallelism: 1,
      hashLen: 32,
      type: argon2.ArgonType.Argon2id,
    });

    return hash.encoded;
  }

  static async deriveSyncKey(
    password: string,
    kdf: Argon2idKdfConfig
  ): Promise<Uint8Array> {
    if (typeof password !== "string" || password.length === 0) {
      throw new Error("Sync password is invalid");
    }
    validateKdfConfig(kdf);
    const result = await argon2.hash({
      pass: password,
      salt: decodeBase64(kdf.salt, "Argon2 salt"),
      time: kdf.time,
      mem: kdf.memoryKiB,
      parallelism: kdf.parallelism,
      hashLen: kdf.hashLength,
      type: argon2.ArgonType.Argon2id,
    });
    if (!(result.hash instanceof Uint8Array) || result.hash.byteLength !== 32) {
      throw new Error("Argon2 returned an invalid derived key");
    }
    return result.hash;
  }

  static compareHash(hash: string, value: string) {
    return new Promise((resolve: (value: boolean) => void) => {
      argon2
        .verify({
          pass: value,
          encoded: hash,
        })
        .then(() => resolve(true))
        .catch((e: { message: string; code: number }) => {
          console.error("Error decoding hash", e);
          resolve(false);
        });
    });
  }
}
