// Static Android security check for the TrustVault app.
//
//   cd apps/mobile && dart run tool/android_security_check.dart [--merged]
//
// Reads the source manifests, the data-extraction rules, any network
// security config and the Gradle build file, and fails (exit 1) when a
// release build would:
//   * allow backup or device-to-device transfer of app data,
//   * allow cleartext HTTP (manifest flag or network security config),
//   * trust user-installed CAs,
//   * export any component other than the launcher activity,
//   * be debuggable, or ship without minification,
//   * request storage/media permissions or other risky permissions,
//   * target or support an SDK that is too old,
//   * drop the task-hijacking defence (taskAffinity="").
// With --merged it also checks the merged release manifest Gradle produced
// (run `flutter build apk --release` first), which includes everything the
// plugins add. test/android_static_security_test.dart runs the same checks
// under `flutter test`.
import 'dart:io';

import 'package:xml/xml.dart';

const _android = 'http://schemas.android.com/apk/res/android';
const _tools = 'http://schemas.android.com/tools';

/// Permissions the app may hold. Add here only with a reason in
/// docs/ANDROID_SECURITY.md.
const allowedPermissions = {
  'android.permission.INTERNET', // the API
  'android.permission.USE_BIOMETRIC', // app lock (mfa-advanced branch)
  'android.permission.USE_FINGERPRINT', // app lock on old devices (androidx.biometric)
  'android.permission.ACCESS_NETWORK_STATE', // added by some plugins
  // Added by AndroidX core to every app (protects its own unexported receiver).
  'cloud.rayyanazeem.trustvault.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
};

/// Never acceptable in this app.
const forbiddenPermissions = {
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.READ_LOGS',
  'android.permission.BIND_ACCESSIBILITY_SERVICE',
};

const minSdkFloor = 24; // Keystore-backed encrypted storage, FBE, scoped storage defaults
const targetSdkFloor = 34;

class Finding {
  Finding(this.file, this.message);
  final String file;
  final String message;
  @override
  String toString() => '$file: $message';
}

class AndroidSecurityCheck {
  AndroidSecurityCheck(this.appRoot); // apps/mobile
  final String appRoot;
  final findings = <Finding>[];
  final passed = <String>[];

  String get _src => '$appRoot/android/app/src';
  String get _main => '$_src/main/AndroidManifest.xml';
  File _f(String p) => File(p);

  void _fail(String file, String msg) => findings.add(Finding(file.replaceFirst('$appRoot/', ''), msg));
  void _ok(String msg) => passed.add(msg);

  static String? attr(XmlElement e, String local, [String ns = _android]) => e.getAttribute(local, namespaceUri: ns);

  XmlDocument _xml(String path) => XmlDocument.parse(_f(path).readAsStringSync());

  List<Finding> runAll({bool merged = false}) {
    checkMainManifest();
    checkBuildTypeManifests();
    checkDataExtractionRules();
    checkNetworkSecurityConfig();
    checkGradle();
    if (merged) checkMergedManifest();
    return findings;
  }

  // ---------------------------------------------------------------- manifest

  void checkMainManifest() => _checkManifest(_main, isMerged: false);

  void _checkManifest(String path, {required bool isMerged}) {
    final doc = _xml(path);
    final manifest = doc.rootElement;
    final app = manifest.findElements('application').firstOrNull;
    if (app == null) return _fail(path, 'no <application>');

    if (attr(app, 'allowBackup') != 'false') _fail(path, 'android:allowBackup must be "false"');
    if (attr(app, 'fullBackupContent') != 'false') _fail(path, 'android:fullBackupContent must be "false" (Android 11 and older)');
    if (attr(app, 'dataExtractionRules') == null) _fail(path, 'android:dataExtractionRules missing (Android 12+ backup/transfer)');
    if (attr(app, 'usesCleartextTraffic') != 'false') _fail(path, 'android:usesCleartextTraffic must be "false"');
    if (attr(app, 'debuggable') == 'true') _fail(path, 'android:debuggable="true"');
    if (attr(app, 'testOnly') == 'true') _fail(path, 'android:testOnly="true"');
    if (attr(app, 'allowClearUserData') == 'false') _fail(path, 'android:allowClearUserData="false" stops the user wiping app data');
    if (attr(app, 'requestLegacyExternalStorage') == 'true') _fail(path, 'requestLegacyExternalStorage="true"');
    if (attr(app, 'hasFragileUserData') == 'true') _fail(path, 'hasFragileUserData="true" keeps data after uninstall');

    // Permissions actually requested (ignoring tools:node="remove").
    for (final p in manifest.findElements('uses-permission').followedBy(manifest.findElements('uses-permission-sdk-23'))) {
      final name = attr(p, 'name') ?? '';
      if (attr(p, 'node', _tools) == 'remove') continue;
      if (forbiddenPermissions.contains(name)) {
        _fail(path, 'forbidden permission $name');
      } else if (!allowedPermissions.contains(name) && !(isMerged && name.endsWith('.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'))) {
        _fail(path, 'permission $name is not on the allowlist (tool/android_security_check.dart)');
      }
    }
    if (!isMerged) {
      // The source manifest must actively strip what plugins (open_filex) add.
      final removed = manifest.findElements('uses-permission').where((p) => attr(p, 'node', _tools) == 'remove').map((p) => attr(p, 'name')).toSet();
      for (final p in ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_MEDIA_AUDIO']) {
        if (!removed.contains(p)) _fail(path, '$p (added by open_filex) must be removed with tools:node="remove"');
      }
    }

    // Components: only the launcher activity may be exported.
    var launchers = 0;
    for (final kind in ['activity', 'activity-alias', 'service', 'receiver', 'provider']) {
      for (final c in app.findElements(kind)) {
        final name = attr(c, 'name') ?? '?';
        final filters = c.findElements('intent-filter').toList();
        final isLauncher = kind == 'activity' &&
            filters.any((f) =>
                f.findElements('action').any((a) => attr(a, 'name') == 'android.intent.action.MAIN') &&
                f.findElements('category').any((a) => attr(a, 'name') == 'android.intent.category.LAUNCHER'));
        final exported = attr(c, 'exported');
        if (filters.isNotEmpty && exported == null) _fail(path, '$kind $name has an intent-filter but no explicit android:exported');
        if (isLauncher) {
          launchers++;
          if (exported != 'true') _fail(path, 'launcher activity $name must be exported="true"');
          if (attr(c, 'taskAffinity') != '') _fail(path, 'launcher activity $name should keep android:taskAffinity="" (task hijacking)');
          final otherFilters = filters.where((f) => !f.findElements('category').any((a) => attr(a, 'name') == 'android.intent.category.LAUNCHER'));
          if (otherFilters.isNotEmpty) _fail(path, 'launcher activity $name has extra intent-filters (deep links need a review)');
          continue;
        }
        if (exported == 'true') {
          final perm = attr(c, 'permission');
          if (!(isMerged && perm != null && perm.startsWith('android.permission.'))) {
            _fail(path, '$kind $name is exported');
          }
        }
        if (kind == 'provider' && attr(c, 'grantUriPermissions') == 'true' && exported == 'true') _fail(path, 'provider $name exported with grantUriPermissions');
      }
    }
    if (launchers != 1) _fail(path, 'expected exactly one launcher activity, found $launchers');
    if (findings.isEmpty) _ok('manifest ${path.replaceFirst('$appRoot/', '')}');
  }

  /// Debug/profile manifests may relax cleartext (local API); nothing else
  /// may, and there must be no release override.
  void checkBuildTypeManifests() {
    final dir = Directory(_src);
    for (final d in dir.listSync().whereType<Directory>()) {
      final name = d.uri.pathSegments.where((s) => s.isNotEmpty).last;
      final m = File('${d.path}/AndroidManifest.xml');
      if (name == 'main' || !m.existsSync()) continue;
      final app = _xml(m.path).rootElement.findElements('application').firstOrNull;
      if (app == null) continue;
      if (name != 'debug' && name != 'profile') {
        _fail(m.path, 'source set "$name" overrides <application>; only debug/profile may');
      }
      for (final a in app.attributes) {
        final key = a.name.local;
        if (a.name.namespaceUri == _tools) continue;
        if (key == 'usesCleartextTraffic' && (name == 'debug' || name == 'profile')) continue;
        _fail(m.path, 'source set "$name" overrides android:$key');
      }
    }
    final release = File('$_src/release/AndroidManifest.xml');
    if (release.existsSync()) _fail(release.path, 'a release manifest exists; review it');
  }

  // ---------------------------------------------------------- backup rules

  void checkDataExtractionRules() {
    final main = _xml(_main).rootElement.findElements('application').first;
    final ref = attr(main, 'dataExtractionRules');
    if (ref == null || !ref.startsWith('@xml/')) return;
    final path = '$_src/main/res/xml/${ref.substring(5)}.xml';
    if (!_f(path).existsSync()) return _fail(path, 'data extraction rules file missing');
    final root = _xml(path).rootElement;
    const domains = {'root', 'file', 'database', 'sharedpref', 'external'};
    for (final section in ['cloud-backup', 'device-transfer']) {
      final s = root.findElements(section).firstOrNull;
      if (s == null) {
        _fail(path, '<$section> missing: everything would be included');
        continue;
      }
      if (s.findElements('include').isNotEmpty) _fail(path, '<$section> has <include>');
      final excluded = s.findElements('exclude').where((e) => (e.getAttribute('path') ?? '.') == '.' || e.getAttribute('path') == null).map((e) => e.getAttribute('domain')).toSet();
      final missing = domains.difference(excluded);
      if (missing.isNotEmpty) _fail(path, '<$section> does not exclude: ${missing.join(', ')}');
    }
  }

  // -------------------------------------------------------- network config

  void checkNetworkSecurityConfig() {
    final main = _xml(_main).rootElement.findElements('application').first;
    final ref = attr(main, 'networkSecurityConfig');
    if (ref == null) {
      _ok('no network security config (platform defaults: no cleartext, system CAs only)');
      return;
    }
    final path = '$_src/main/res/xml/${ref.substring(5)}.xml';
    final root = _xml(path).rootElement;
    for (final e in root.descendantElements) {
      if (e.getAttribute('cleartextTrafficPermitted') == 'true' && e.name.local != 'debug-overrides') {
        _fail(path, '<${e.name.local}> permits cleartext');
      }
      if (e.name.local == 'certificates' && e.getAttribute('src') == 'user' && e.ancestorElements.every((a) => a.name.local != 'debug-overrides')) {
        _fail(path, 'trusts user-installed CAs outside debug-overrides');
      }
      if (e.getAttribute('overridePins') == 'true') _fail(path, 'overridePins="true"');
    }
  }

  // ------------------------------------------------------------------ gradle

  void checkGradle() {
    final path = '$appRoot/android/app/build.gradle.kts';
    final g = _f(path).readAsStringSync();
    final release = RegExp(r'release\s*\{([^}]*)\}', dotAll: true).firstMatch(g.substring(g.indexOf('buildTypes')))?.group(1) ?? '';
    if (RegExp(r'isDebuggable\s*=\s*true').hasMatch(release)) _fail(path, 'release isDebuggable = true');
    if (RegExp(r'isJniDebuggable\s*=\s*true').hasMatch(release)) _fail(path, 'release isJniDebuggable = true');
    if (!RegExp(r'isMinifyEnabled\s*=\s*true').hasMatch(release)) _fail(path, 'release must set isMinifyEnabled = true');
    final min = RegExp(r'minSdk\s*=\s*(\S+)').firstMatch(g)?.group(1);
    final target = RegExp(r'targetSdk\s*=\s*(\S+)').firstMatch(g)?.group(1);
    final minV = _sdk(min, 'minSdkVersion');
    final targetV = _sdk(target, 'targetSdkVersion');
    if (minV == null || minV < minSdkFloor) _fail(path, 'minSdk ${minV ?? min} is below $minSdkFloor');
    if (targetV == null || targetV < targetSdkFloor) _fail(path, 'targetSdk ${targetV ?? target} is below $targetSdkFloor');
    if (g.contains('key.properties') && File('$appRoot/android/key.properties').existsSync()) {
      final ignored = File('$appRoot/android/.gitignore').readAsStringSync().contains('key.properties');
      if (!ignored) _fail(path, 'android/key.properties exists and is not git-ignored');
    }
  }

  /// `flutter.minSdkVersion` → the Flutter Gradle plugin's default.
  int? _sdk(String? v, String flutterField) {
    if (v == null) return null;
    final n = int.tryParse(v);
    if (n != null) return n;
    if (v == 'flutter.$flutterField') {
      final root = Platform.environment['FLUTTER_ROOT'] ?? _flutterRootFromPath();
      if (root == null) return null;
      final ext = File('$root/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt');
      if (!ext.existsSync()) return null;
      final m = RegExp('val $flutterField: Int = (\\d+)').firstMatch(ext.readAsStringSync());
      return m == null ? null : int.parse(m.group(1)!);
    }
    return null;
  }

  static String? _flutterRootFromPath() {
    // dart/flutter_tester from inside the Flutter SDK: <root>/bin/cache/...
    final exe = File(Platform.resolvedExecutable).absolute.path.replaceAll(r'\', '/');
    final i = exe.indexOf('/bin/cache/');
    return i < 0 ? null : exe.substring(0, i);
  }

  // ------------------------------------------------------------------ merged

  /// The release manifest after plugins are merged in (needs a release build).
  String? mergedManifestPath() {
    for (final rel in [
      'build/app/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml',
      'build/app/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml',
      'build/app/intermediates/merged_manifest/release/AndroidManifest.xml',
    ]) {
      final f = File('$appRoot/$rel');
      if (f.existsSync()) return f.path;
    }
    final dir = Directory('$appRoot/build/app/intermediates');
    if (!dir.existsSync()) return null;
    return dir
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.replaceAll(r'\', '/').contains('/release/') && f.path.endsWith('AndroidManifest.xml') && f.path.contains('merged_manifest'))
        .map((f) => f.path)
        .firstOrNull;
  }

  void checkMergedManifest() {
    final path = mergedManifestPath();
    if (path == null) return _fail('build/', 'no merged release manifest; run `flutter build apk --release` first');
    _checkManifest(path, isMerged: true);
  }
}

void main(List<String> args) {
  final root = File(Platform.script.toFilePath()).parent.parent.path.replaceAll(r'\', '/');
  final check = AndroidSecurityCheck(root);
  final findings = check.runAll(merged: args.contains('--merged'));
  if (findings.isEmpty) {
    stdout.writeln('Android security check: OK${args.contains('--merged') ? ' (source and merged release manifest)' : ''}');
    return;
  }
  stderr.writeln('Android security check: ${findings.length} problem(s)');
  for (final f in findings) {
    stderr.writeln('  - $f');
  }
  exitCode = 1;
}
