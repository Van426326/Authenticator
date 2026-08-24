#!/bin/bash
set -euo pipefail

npm run prod

VERSION="$(node -p 'require("./manifests/manifest-chrome.json").version')"
TAG="v${VERSION}"
ASSET_DIR="release-assets"

rm -rf "$ASSET_DIR"
mkdir -p "$ASSET_DIR"

# Chrome extensions are platform-independent; the release workflow rebuilds
# these assets on the named operating systems for platform-specific validation.
for PLATFORM in macos windows; do
  (
    cd release/chrome
    zip -qr "../../${ASSET_DIR}/authenticator-chrome-${PLATFORM}-${TAG}.zip" .
  )
done

(
  cd "$ASSET_DIR"
  shasum -a 256 ./*.zip > SHA256SUMS.txt
)
