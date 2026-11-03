#!/usr/bin/env bash
# Static Android security check (see docs/ANDROID_SECURITY.md).
#   tools/android-security-check.sh            source manifests, backup rules, Gradle
#   tools/android-security-check.sh --merged   also the merged release manifest (after flutter build apk --release)
set -euo pipefail
cd "$(dirname "$0")/../apps/mobile"
exec dart run tool/android_security_check.dart "$@"
