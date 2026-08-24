import { decodeBase64 } from "../Base64";

/**
 * Decodes Base64 returned by GitHub's Git Blobs API. GitHub line-folds blob
 * content with LF characters, while the shared decoder intentionally accepts
 * only canonical, unbroken Base64. Remove only GitHub's documented transport
 * folding; spaces, tabs, lone CR characters, and non-Base64 bytes still fail
 * closed in the strict decoder.
 */
export function decodeGitHubBlobBase64(
  content: string,
  label: string
): Uint8Array {
  if (content.includes("\r")) {
    const withoutCrLf = content.replace(/\r\n/g, "\n");
    if (withoutCrLf.includes("\r")) {
      throw new Error(`${label} is not valid base64`);
    }
    return decodeBase64(withoutCrLf.replace(/\n/g, ""), label);
  }
  return decodeBase64(content.replace(/\n/g, ""), label);
}
