import "mocha";
import { assert } from "chai";

const GITHUB_API_ORIGIN = "https://api.github.com/*";

/**
 * Transport surface regression guards: WebDAV has been removed from the
 * extension entirely. These tests run against the shipped test build and
 * assert that (1) the shipped manifest declares only the GitHub API origin,
 * permits GitHub API traffic in its CSP, and never mentions WebDAV, and (2)
 * the production background bundle contains none of the deleted WebDAV
 * transport modules. The one intentional exception is the one-time legacy
 * `removeLegacyWebDavKeys` cleanup, which only deletes stale WebDAV storage
 * keys and never selects or executes a WebDAV transport.
 */
describe("GitHub-only synchronization surface", () => {
  it("declares no WebDAV anywhere in the shipped manifest", () => {
    const manifest = chrome.runtime.getManifest();
    assert.notInclude(
      JSON.stringify(manifest).toLowerCase(),
      "webdav",
    );
  });

  it("narrows optional host permissions to the GitHub API origin", () => {
    const manifest = chrome.runtime.getManifest();
    const hostPermissions =
      manifest.optional_host_permissions ??
      ((manifest.optional_permissions as string[] | undefined) ?? []).filter(
        (permission) => permission.startsWith("https://"),
      );
    assert.deepEqual(hostPermissions, [GITHUB_API_ORIGIN]);
  });

  it("keeps a content security policy that permits the GitHub API", () => {
    const manifest = chrome.runtime.getManifest();
    const csp = manifest.content_security_policy;
    const policy =
      typeof csp === "string" ? csp : csp?.extension_pages ?? "";
    assert.match(policy, /connect-src [^;]*https:/);
  });

  it("ships no WebDAV transport modules in the production background bundle", async () => {
    // Fixed extension resource: the built background entry, never user input.
    const backgroundBundleUrl = chrome.runtime.getURL("dist/background.js");
    const bundle = await fetch(backgroundBundleUrl).then((response) =>
      response.text()
    );
    for (const identifier of [
      "WebDavTransport",
      "WebDavRepository",
      "WebDavOperationStore",
      "WebDavConnectionService",
      "WebDavCapabilityProbe",
      "WebDavXml",
      "normalizeWebDavBaseUrl",
      "WebDavHttpError",
      "WebDavRedirectError",
      "WebDavResponseTooLargeError",
      "UnsupportedWebDavServerError",
    ]) {
      assert.notInclude(bundle, identifier);
    }
    // The only remaining WebDAV reference is the one-time legacy storage-key
    // cleanup, which never selects or executes a WebDAV transport.
    assert.include(bundle, "removeLegacyWebDavKeys");
  });
});
