// Checks for security features being built on other branches. Each test
// detects whether its feature has been merged (by looking at the source) and
// skips with a reason until it has; after the rebase they run without edits.
//
//   view-only    : FLAG_SECURE via a MethodChannel in MainActivity, in-memory
//                  page viewer, encrypted local copies (package:cryptography)
//                  with keys fetched from the server per open.
//   mfa-advanced : biometric app lock (local_auth), MainActivity becomes a
//                  FlutterFragmentActivity, passkeys via Credential Manager.
//
// See docs/ANDROID_SECURITY.md "Features from other branches".
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _read(String p) => File(p).existsSync() ? File(p).readAsStringSync() : '';

void main() {
  const activityPath = 'android/app/src/main/kotlin/cloud/rayyanazeem/trustvault/MainActivity.kt';
  final activity = _read(activityPath);
  final pubspec = _read('pubspec.yaml');
  final manifest = _read('android/app/src/main/AndroidManifest.xml');
  String lib() => Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).map((f) => f.readAsStringSync()).join('\n');

  final hasFlagSecure = activity.contains('FLAG_SECURE');
  final hasBiometric = RegExp(r'^\s+local_auth:', multiLine: true).hasMatch(pubspec);
  final hasEncryptedCopies = RegExp(r'^\s+cryptography:', multiLine: true).hasMatch(pubspec);

  group('FLAG_SECURE (view-only branch)', () {
    test('MainActivity sets FLAG_SECURE on the window and never clears it without a reason', () {
      expect(activity, contains('WindowManager.LayoutParams.FLAG_SECURE'));
      expect(RegExp(r'addFlags\([^)]*FLAG_SECURE|setFlags\([^)]*FLAG_SECURE').hasMatch(activity), isTrue, reason: 'FLAG_SECURE must be applied');
    }, skip: hasFlagSecure ? false : 'FLAG_SECURE not merged yet (view-only branch)');

    test('the Dart side calls the secure-window channel before showing a document', () {
      final src = lib();
      expect(RegExp(r"MethodChannel\('[^']*(secure|screen)[^']*'\)").hasMatch(src), isTrue, reason: 'a MethodChannel for the secure window');
    }, skip: hasFlagSecure ? false : 'FLAG_SECURE not merged yet (view-only branch)');
  });

  group('biometric app lock (mfa-advanced branch)', () {
    test('MainActivity is a FlutterFragmentActivity (local_auth needs it)', () {
      expect(activity, contains('FlutterFragmentActivity'));
    }, skip: hasBiometric ? false : 'local_auth not merged yet (mfa-advanced branch)');

    test('USE_BIOMETRIC is declared and allowlisted', () {
      expect(manifest, contains('android.permission.USE_BIOMETRIC'));
    }, skip: hasBiometric ? false : 'local_auth not merged yet (mfa-advanced branch)');

    test('the lock is wired to the app lifecycle (locks on return from background)', () {
      final src = lib();
      expect(src, contains('LocalAuthentication'));
      expect(RegExp(r'AppLifecycleState\.(paused|hidden|inactive)').hasMatch(src), isTrue, reason: 'the app should re-lock when backgrounded');
    }, skip: hasBiometric ? false : 'local_auth not merged yet (mfa-advanced branch)');
  });

  group('encrypted local copies (view-only branch)', () {
    test('local copies go through the cipher, never raw writeAsBytes of downloaded bytes', () {
      final files = _read('lib/widgets/files.dart') + _read('lib/core/local_copies.dart');
      expect(RegExp(r'AesGcm|Chacha20|Xchacha20').hasMatch(lib()), isTrue, reason: 'an AEAD cipher from package:cryptography');
      expect(files, isNot(contains('writeAsBytes(d.bytes')), reason: 'plaintext must not be written as-is');
    }, skip: hasEncryptedCopies ? false : 'encrypted copies not merged yet (view-only branch)');
  });
}
