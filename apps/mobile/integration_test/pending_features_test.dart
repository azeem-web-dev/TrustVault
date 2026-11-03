// On-device checks for features merged from other branches. They are
// skipped until the feature lands; enable one by passing its flag:
//
//   flutter test integration_test/pending_features_test.dart -d emulator-5554 \
//     --dart-define=TV_HAS_FLAG_SECURE=true \
//     --dart-define=TV_HAS_APP_LOCK=true \
//     --dart-define=TV_HAS_ENCRYPTED_COPIES=true
//
// The parts that need the host (screenshots, screen recording, the recents
// thumbnail) are in tool/android-device-checks.sh, which runs adb against
// the same emulator. See docs/ANDROID_SECURITY.md.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

const hasFlagSecure = bool.fromEnvironment('TV_HAS_FLAG_SECURE');
const hasAppLock = bool.fromEnvironment('TV_HAS_APP_LOCK');
const hasEncryptedCopies = bool.fromEnvironment('TV_HAS_ENCRYPTED_COPIES');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('FLAG_SECURE (view-only)', () {
    testWidgets('opening a document turns on the secure window; leaving turns it off only where intended', (tester) async {
      // After the rebase: start the app against the fake API (see
      // app_security_test.dart), open a document in the page viewer, then
      // ask the platform side whether FLAG_SECURE is set. The view-only branch
      // adds a MethodChannel in MainActivity; add a debug-only "isSecure"
      // method to it, or assert from the host with
      // `adb shell dumpsys window | grep -i FLAG_SECURE` (android-device-checks.sh).
      const channel = MethodChannel('trustvault/secure_window');
      final secure = await channel.invokeMethod<bool>('isSecure');
      expect(secure, isTrue);
    }, skip: !hasFlagSecure);
  });

  group('biometric app lock (mfa-advanced)', () {
    testWidgets('returning from the background shows the lock before any document', (tester) async {
      // After the rebase: sign in (app_security_test.dart helpers), send
      // paused → resumed through binding.handleAppLifecycleStateChanged, and
      // expect the lock screen; no document title may be visible until the
      // (mocked) local_auth channel answers true. The emulator can also
      // enrol a fingerprint: `adb -e emu finger touch 1`.
      fail('fill in after rebasing onto mfa-advanced');
    }, skip: !hasAppLock);
  });

  group('encrypted local copies (view-only)', () {
    testWidgets('no plaintext of an opened document anywhere in app data; revoke makes the copy unreadable', (tester) async {
      // After the rebase: reuse filesContaining(marker) from
      // app_security_test.dart after opening a document — it must be empty
      // even while the document is open. Then revoke on the fake API and
      // check the server refuses the key, so the encrypted copy cannot be
      // opened offline either.
      fail('fill in after rebasing onto view-only');
    }, skip: !hasEncryptedCopies);
  });
}
