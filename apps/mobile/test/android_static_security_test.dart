// Runs tool/android_security_check.dart under `flutter test`, and checks
// that the checker itself catches each problem (so a silent checker cannot
// pass CI).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../tool/android_security_check.dart';

void main() {
  final root = Directory.current.path.replaceAll(r'\', '/');

  test('the app passes the static Android security check', () {
    final c = AndroidSecurityCheck(root);
    final findings = c.runAll();
    expect(findings.map((f) => '$f'), isEmpty);
  });

  test('the merged release manifest passes too (when a release build exists)', () {
    final c = AndroidSecurityCheck(root);
    if (c.mergedManifestPath() == null) {
      markTestSkipped('no release build: run `flutter build apk --release` then `dart run tool/android_security_check.dart --merged`');
      return;
    }
    c.checkMergedManifest();
    expect(c.findings.map((f) => '$f'), isEmpty);
  });

  group('the checker catches', () {
    late Directory tmp;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('tv-static-');
      _copy(Directory('$root/android/app'), Directory('${tmp.path}/android/app'));
      File('$root/android/.gitignore').copySync('${tmp.path}/android/.gitignore');
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    List<String> run() => AndroidSecurityCheck(tmp.path.replaceAll(r'\', '/')).runAll().map((f) => f.message).toList();
    File manifest() => File('${tmp.path}/android/app/src/main/AndroidManifest.xml');
    void edit(File f, String from, String to) {
      final s = f.readAsStringSync();
      expect(s.contains(from), isTrue, reason: 'fixture text "$from" not found');
      f.writeAsStringSync(s.replaceFirst(from, to));
    }

    test('baseline copy is clean', () => expect(run(), isEmpty));

    test('allowBackup="true"', () {
      edit(manifest(), 'android:allowBackup="false"', 'android:allowBackup="true"');
      expect(run(), contains(contains('allowBackup')));
    });

    test('cleartext allowed in main', () {
      edit(manifest(), 'android:usesCleartextTraffic="false"', 'android:usesCleartextTraffic="true"');
      expect(run(), contains(contains('usesCleartextTraffic')));
    });

    test('debuggable in the manifest', () {
      edit(manifest(), 'android:label="TrustVault"', 'android:label="TrustVault" android:debuggable="true"');
      expect(run(), contains(contains('debuggable')));
    });

    test('an exported service', () {
      edit(manifest(), '</application>', '<service android:name=".Leak" android:exported="true"/></application>');
      expect(run(), contains(contains('service .Leak is exported')));
    });

    test('an intent-filter without explicit exported', () {
      edit(manifest(), '</application>', '<receiver android:name=".R"><intent-filter><action android:name="x"/></intent-filter></receiver></application>');
      expect(run(), contains(contains('no explicit android:exported')));
    });

    test('a deep link on the launcher', () {
      edit(manifest(), '</activity>', '<intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="tv"/></intent-filter></activity>');
      expect(run(), contains(contains('extra intent-filters')));
    });

    test('taskAffinity removed', () {
      edit(manifest(), 'android:taskAffinity=""', '');
      expect(run(), contains(contains('taskAffinity')));
    });

    test('a storage permission, and the open_filex removal dropped', () {
      edit(manifest(), '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" tools:node="remove"/>', '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"/>');
      final r = run();
      expect(r, contains(contains('forbidden permission android.permission.WRITE_EXTERNAL_STORAGE')));
      expect(r, contains(contains('READ_MEDIA_IMAGES (added by open_filex)')));
    });

    test('a backup domain left out', () {
      edit(File('${tmp.path}/android/app/src/main/res/xml/data_extraction_rules.xml'), '<device-transfer><exclude domain="root"/>', '<device-transfer>');
      expect(run(), contains(contains('<device-transfer> does not exclude: root')));
    });

    test('a network security config allowing cleartext or user CAs', () {
      edit(manifest(), 'android:label="TrustVault"', 'android:label="TrustVault" android:networkSecurityConfig="@xml/nsc"');
      File('${tmp.path}/android/app/src/main/res/xml/nsc.xml').writeAsStringSync(
        '<network-security-config><base-config cleartextTrafficPermitted="true"><trust-anchors><certificates src="user"/></trust-anchors></base-config></network-security-config>',
      );
      final r = run();
      expect(r, contains(contains('permits cleartext')));
      expect(r, contains(contains('user-installed CAs')));
    });

    test('a release build type that is debuggable or not minified', () {
      final g = File('${tmp.path}/android/app/build.gradle.kts');
      edit(g, 'isMinifyEnabled = true', 'isMinifyEnabled = false\n            isDebuggable = true');
      final r = run();
      expect(r, contains(contains('isMinifyEnabled')));
      expect(r, contains(contains('isDebuggable')));
    });

    test('an old minSdk', () {
      edit(File('${tmp.path}/android/app/build.gradle.kts'), 'minSdk = flutter.minSdkVersion', 'minSdk = 21');
      expect(run(), contains(contains('minSdk 21')));
    });

    test('a release source-set manifest relaxing anything', () {
      File('${tmp.path}/android/app/src/release/AndroidManifest.xml')
        ..createSync(recursive: true)
        ..writeAsStringSync('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="true"/></manifest>');
      expect(run(), contains(contains('source set "release"')));
    });
  });
}

void _copy(Directory from, Directory to) {
  for (final e in from.listSync(recursive: true)) {
    final rel = e.path.substring(from.path.length);
    if (rel.contains('${Platform.pathSeparator}build${Platform.pathSeparator}') || rel.contains('.cxx')) continue;
    if (e is File) {
      File('${to.path}$rel')
        ..createSync(recursive: true)
        ..writeAsBytesSync(e.readAsBytesSync());
    }
  }
}
