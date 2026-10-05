#!/usr/bin/env bash
#
# Build the Android companion into an .apk.
#
# One script, called by two workflows (`mobile.yml` on every push,
# `release.yml` on a tag), for the same reason as build-ios-ipa.sh: a packaging
# step that exists twice is a packaging step that exists in two versions.
#
# No credentials are involved. `assembleDebug` signs with a debug keystore that
# Gradle generates on first use, so a *signed and installable* APK comes out of
# a runner with nothing configured. A release APK signed with a real key needs a
# keystore that belongs to the maintainer, and that is a different step.
#
# The tests run first on purpose. "It compiled" is not "the wire format is
# right", and the relay protocol is the part that can be wrong in a way nobody
# would notice on a phone.

set -euo pipefail

PROJECT_DIR="mobile/android"
OUT_DIR="dist"
APK="$OUT_DIR/app-debug.apk"

log()  { printf '::group::%s\n' "$*"; }
fail() { printf '::error::%s\n' "$*" >&2; exit 1; }

command -v java >/dev/null 2>&1 || fail "java is not on PATH. This script needs a JDK."
[ -d "$PROJECT_DIR" ] || fail "$PROJECT_DIR is missing. There is no Android project to build."

# The runner image ships an SDK, but pinning the platform and build-tools means
# the build does not depend on which image version is current this month.
if [ -n "${ANDROID_HOME:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi
if command -v sdkmanager >/dev/null 2>&1; then
  log "Making sure the SDK platform and build-tools are present"
  yes | sdkmanager --licenses >/dev/null 2>&1 || true
  sdkmanager "platforms;android-34" "build-tools;34.0.0" >/dev/null 2>&1 || \
    echo "::warning::sdkmanager could not install components; using whatever the image has."
fi

GRADLE="gradle"
command -v gradle >/dev/null 2>&1 || fail "gradle is not on PATH."

log "Java version"
java -version 2>&1 | sed -n '1,3p'

log "Unit tests (the relay protocol)"
# `--no-daemon` because a daemon left behind by a finished job is a daemon that
# holds a directory the next job will want.
( cd "$PROJECT_DIR" && "$GRADLE" --no-daemon --console=plain testDebugUnitTest )

# A green `test` on a project with no tests looks exactly like a pass, so the
# report is read rather than trusted — the same shape as the Swift test count
# assertion in mobile.yml.
REPORT="$PROJECT_DIR/app/build/reports/tests/testDebugUnitTest/index.html"
[ -f "$REPORT" ] || fail "No unit test report at $REPORT. The tests did not run."
if [ -f "$PROJECT_DIR/app/build/test-results/testDebugUnitTest/TEST-com.itznpg.cryptoric.companion.RelayProtocolTest.xml" ]; then
  RESULT_FILE="$PROJECT_DIR/app/build/test-results/testDebugUnitTest/TEST-com.itznpg.cryptoric.companion.RelayProtocolTest.xml"
  # No pipes, and no reading just the first line: a JUnit XML file opens with
  # the <?xml?> declaration, so the attributes are several lines down. The whole
  # file goes into a variable and bash's regex pulls the numbers out, which
  # keeps a third SIGPIPE race out of the step that decides whether these tests
  # actually ran.
  XML="$(cat "$RESULT_FILE")"
  COUNT=""; FAILURES=""
  [[ "$XML" =~ tests\="([0-9]+)" ]] && COUNT="${BASH_REMATCH[1]}"
  [[ "$XML" =~ failures\="([0-9]+)" ]] && FAILURES="${BASH_REMATCH[1]}"
  echo "tests=$COUNT failures=$FAILURES"
  [ "${COUNT:-0}" -ge 5 ] || fail "Only ${COUNT:-0} tests ran; a partial run must not read as a pass."
  [ "${FAILURES:-1}" -eq 0 ] || fail "$FAILURES test(s) failed."
else
  fail "No JUnit XML for RelayProtocolTest. The suite did not run."
fi

log "Assembling the debug APK"
( cd "$PROJECT_DIR" && "$GRADLE" --no-daemon --console=plain assembleDebug )

log "Confirming the APK exists"
BUILT="$(find "$PROJECT_DIR/app/build/outputs/apk" -name '*.apk' -print -quit)"
[ -n "$BUILT" ] || fail "No .apk under $PROJECT_DIR/app/build/outputs/apk."
echo "apk=$BUILT"
BYTES="$(wc -c < "$BUILT" | tr -d ' ')"
echo "apk_bytes=$BYTES"
# A real APK for this app is comfortably over 100 KB. Anything smaller is a stub
# or a truncated file, and both would install and then do nothing.
[ "$BYTES" -ge 100000 ] || fail "The APK is $BYTES bytes. That is not an app."

LIST="$(unzip -l "$BUILT")"
# sed, not head: `head` closes the pipe after 20 lines, echo takes SIGPIPE,
# and under `set -o pipefail` that kills the script. sed reads the whole stream.
printf '%s
' "$LIST" | sed -n '1,20p'
# Bash pattern matching, not `echo "$LIST" | grep -q`: grep -q exits on the first
# match and closes the pipe while echo is still writing, which hands the writer a
# SIGPIPE and, under `set -o pipefail`, fails the build at random.
[[ "$LIST" == *"AndroidManifest.xml"* ]] || fail "The APK has no AndroidManifest.xml."
[[ "$LIST" == *"classes.dex"* ]] || fail "The APK has no classes.dex: there is no compiled code in it."

log "Copying into dist/"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$APK"
ls -la "$OUT_DIR/"

log "Done: $APK ($BYTES bytes, debug-signed)"
