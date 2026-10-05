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
# The app bundle is wrapped in Payload/, which is the layout Apple's own
# archives use and the one a sideloading tool looks for when it opens the file.
# Zipping the .app at the archive root was a claim about what Sideloadly and
# AltStore tolerate rather than a format anything guarantees, and a companion
# app that no tool can be relied on to open is not a deliverable. The bundle
# itself is staged rather than moved so the build directory keeps the product
# xcodebuild made.
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/$(basename "$APP")"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
( cd "$STAGE" && zip -qry "$GITHUB_WORKSPACE/$IPA" Payload )
rm -rf "$STAGE"
ls -la "$OUT_DIR/"

BYTES="$(wc -c < "$IPA" | tr -d ' ')"
echo "ipa_bytes=$BYTES"
[ "$BYTES" -ge 100000 ] || fail "The .ipa is $BYTES bytes. That is not a bundle."

LIST="$(unzip -l "$IPA")"
# sed, not head: `head` closes the pipe after 20 lines, echo takes SIGPIPE,
# and under `set -o pipefail` that kills the script. sed reads the whole stream.
printf '%s
' "$LIST" | sed -n '1,20p'
# Bash pattern matching, not `echo "$LIST" | grep -q`: grep -q exits on the first
# match and closes the pipe while echo is still writing, which hands the writer a
# SIGPIPE and, under `set -o pipefail`, fails the build at random.
[[ "$LIST" == *"Payload/$TARGET.app/Info.plist"* ]] || fail "No Payload/$TARGET.app/Info.plist in the archive."
[[ "$LIST" == *"Payload/$TARGET.app/$TARGET"* ]] || fail "The .ipa contains no $TARGET executable under Payload/."

log "Done: $IPA ($BYTES bytes, unsigned)"
