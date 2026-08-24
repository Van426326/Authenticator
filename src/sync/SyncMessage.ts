import { decodeBase64, encodeBase64 } from "./Base64";

const REPOSITORY_KEK_BYTES = 32;

export function encodeRepositoryKekMessage(kek: Uint8Array) {
  if (kek.byteLength !== REPOSITORY_KEK_BYTES) {
    throw new Error("Repository KEK is invalid");
  }
  return encodeBase64(kek);
}

export function decodeRepositoryKekMessage(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Repository KEK message is invalid");
  }
  const kek = decodeBase64(value);
  if (kek.byteLength !== REPOSITORY_KEK_BYTES) {
    throw new Error("Repository KEK message is invalid");
  }
  return kek;
}
