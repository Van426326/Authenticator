/**
 * Computes the canonical Git blob object SHA-1 for exact immutable bytes.
 *
 * Git identifies a blob by SHA-1 over the header `"blob <byteLength>\\0"`
 * followed by the raw content. This is computed locally from the durable
 * envelope bytes so a transport can verify that a remote object still matches
 * the exact bytes that were uploaded, without trusting remote metadata or
 * re-encrypting anything.
 */

function toHex(bytes: Uint8Array) {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + bytes.byteLength);
  combined.set(header, 0);
  combined.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", combined);
  return toHex(new Uint8Array(digest));
}
