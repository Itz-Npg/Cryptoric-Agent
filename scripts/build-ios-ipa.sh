#!/usr/bin/env bash
#
# Build the iOS companion into an .ipa.
#
# One script, called by two workflows (`mobile.yml` on every push, `release.yml`
# on a tag), because a packaging step that exists twice is a packaging step that
# will exist in two different versions. Producing the file needs no Apple
# account: the build runs with signing disabled and the .app is zipped into an
# .ipa. Installing it on a device does need a signature — yours, or a
# re-signing tool — and that is a different step, not a different build.
#
# Every assertion here exists because the failure this guards against is a
# *green* build that produced nothing usable. `xcodebuild` exiting 0, a
# `dist/` directory existing, and a file with the right extension are three
# separate claims, and only the third one is about an installable app.

set -euo pipefail

PROJECT="mobile/ios-app/CryptoricCompanion.xcodeproj"
TARGET="CryptoricCompanion"
PRODUCTS="${RUNNER_TEMP:-/tmp}/products"
OUT_DIR="dist"
IPA="$OUT_DIR/CryptoricCompanion-unsigned.ipa"

log()  { printf '::group::%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild is not on PATH. This script needs macOS."
[ -d "$PROJECT" ] || fail "$PROJECT is missing. There is no app target to build."

log "Building $TARGET for the device SDK (unsigned)"
# SYMROOT rather than -derivedDataPath: the latter is only legal alongside
# -scheme, and this builds by target so no shared scheme has to be checked in.
# CODE_SIGNING_* off because no signing identity exists on a runner, and
# asking for one would make an artifact that needs no account impossible.
xcodebuild \
  -project "$PROJECT" \
  -target "$TARGET" \
  -sdk iphoneos \
  -configuration Release \
  SYMROOT="$PRODUCTS" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build 2>&1 | tee /tmp/xcodebuild.log

grep -q "BUILD SUCCEEDED" /tmp/xcodebuild.log || {
  tail -40 /tmp/xcodebuild.log
  fail "xcodebuild never reported BUILD SUCCEEDED."
}

log "Confirming the bundle exists"
APP="$(find "$PRODUCTS/Release-iphoneos" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP" ] || fail "No .app in $PRODUCTS/Release-iphoneos. A library cannot produce one."
echo "app=$APP"
ls -la "$APP"

log "Packaging the .ipa"
# The .app sits at the archive root, which is the layout Sideloadly, AltStore
# and SideStore read. App Store submissions wrap it in Payload/ instead; that
# is a different file for a different purpose.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
( cd "$(dirname "$APP")" && zip -qry "$GITHUB_WORKSPACE/$IPA" "$(basename "$APP")" )
ls -la "$OUT_DIR/"

BYTES="$(wc -c < "$IPA" | tr -d ' ')"
echo "ipa_bytes=$BYTES"
[ "$BYTES" -ge 100000 ] || fail "The .ipa is $BYTES bytes. That is not a bundle."

LIST="$(unzip -l "$IPA")"
echo "$LIST" | head -20
echo "$LIST" | grep -q "$TARGET.app/Info.plist" || fail "No $TARGET.app/Info.plist at the archive root."
echo "$LIST" | grep -q "$TARGET.app/$TARGET$" || fail "The .ipa contains no $TARGET executable."

log "Done: $IPA ($BYTES bytes, unsigned)"
