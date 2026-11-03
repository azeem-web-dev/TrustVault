#!/usr/bin/env bash
# Host-side checks on an installed TrustVault build, over adb.
#
#   apps/mobile/tool/android-device-checks.sh [-s emulator-5554] [--expect-secure]
#
# Run it after the integration tests (or after using the app by hand) on an
# emulator or a test phone. It never talks to the TrustVault server.
#
#  1. package flags: not debuggable / no backup (release builds only)
#  2. logcat: no session cookie, CSRF header or bearer token was logged
#  3. app data (debug builds, via run-as): no plaintext downloads left after
#     sign-out, nothing on shared storage
#  4. screenshot of the current screen: with --expect-secure (FLAG_SECURE
#     merged, a document open) the capture must be blank
set -euo pipefail

PKG=cloud.rayyanazeem.trustvault
ADB=(adb)
EXPECT_SECURE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) ADB=(adb -s "$2"); shift 2 ;;
    --expect-secure) EXPECT_SECURE=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

fail=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }
note() { echo "  note $*"; }

echo "TrustVault device checks ($PKG)"
"${ADB[@]}" get-state >/dev/null || { echo "no device" >&2; exit 2; }
"${ADB[@]}" shell pm path "$PKG" >/dev/null 2>&1 || { echo "$PKG is not installed" >&2; exit 2; }

# 1. Package flags ----------------------------------------------------------
flags=$("${ADB[@]}" shell dumpsys package "$PKG" | tr -d '\r' | grep -m1 -E '^\s+flags=\[' || true)
if echo "$flags" | grep -q DEBUGGABLE; then
  note "installed build is DEBUGGABLE (expected for debug/integration builds; a release build must not be)"
  debuggable=1
else
  ok "not debuggable"
  debuggable=0
fi
if echo "$flags" | grep -q ALLOW_BACKUP; then bad "ALLOW_BACKUP is set"; else ok "backup not allowed"; fi

# 2. Logs -----------------------------------------------------------------
if "${ADB[@]}" logcat -d 2>/dev/null | tr -d '\r' | grep -E -i '__Host-tv_session=[A-Za-z0-9_-]{8,}|x-csrf-token: *[A-Za-z0-9_-]{8,}|authorization: *bearer' >/dev/null; then
  bad "a session cookie / CSRF token / bearer token appears in logcat"
else
  ok "no session secrets in logcat"
fi

# 3. Files ----------------------------------------------------------------
if [ "$debuggable" = 1 ]; then
  listing=$("${ADB[@]}" shell run-as "$PKG" find . -type f 2>/dev/null | tr -d '\r' || true)
  if echo "$listing" | grep -q '^./app_flutter/downloads/'; then
    note "downloaded copies present (fine while signed in; must be gone after sign-out):"
    echo "$listing" | grep '^./app_flutter/downloads/' | sed 's/^/         /'
  else
    ok "no downloaded copies in app storage"
  fi
  if echo "$listing" | grep -q '^./cache/file_picker/'; then note "file-picker temp copies present"; fi
else
  note "release build: app files are not readable without root (run-as needs a debuggable build)"
fi
if "${ADB[@]}" shell ls "/sdcard/Android/data/$PKG" >/dev/null 2>&1; then
  bad "the app has an external-storage folder /sdcard/Android/data/$PKG"
else
  ok "nothing on shared/external storage"
fi

# 4. Screenshot -------------------------------------------------------------
tmp=$(mktemp -d)
"${ADB[@]}" exec-out screencap -p > "$tmp/screen.png" || true
if command -v python3 >/dev/null 2>&1 && python3 -c 'import PIL' 2>/dev/null; then
  colours=$(python3 - "$tmp/screen.png" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB').resize((64, 128))
print(len(set(im.getdata())))
PY
)
  if [ "$EXPECT_SECURE" = 1 ]; then
    if [ "$colours" -le 2 ]; then ok "screenshot is blank (FLAG_SECURE works)"; else bad "screenshot shows content ($colours colours) while a secure screen was expected"; fi
  else
    note "screenshot has $colours colours (FLAG_SECURE not expected on this build)"
  fi
else
  note "screenshot saved to $tmp/screen.png (install python3 + Pillow to judge it automatically)"
fi

[ "$fail" = 0 ] && echo "PASS" || echo "FAILED"
exit "$fail"
