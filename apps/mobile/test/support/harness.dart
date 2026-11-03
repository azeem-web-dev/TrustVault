// Shared set-up for the Android security tests: a fake API, in-memory
// Keystore storage, in-memory shared preferences and a fake app sandbox
// (path_provider) rooted in a temporary folder, so tests can look at every
// file the app wrote.
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:open_filex/open_filex.dart';
import 'package:trustvault/core/api.dart';
import 'package:trustvault/widgets/files.dart';

import 'fake_api.dart';

/// A fake Android app sandbox: `files/` (app documents), `cache/` (temp),
/// `support/` and an `external/` folder the app must never use.
class FakeSandbox extends PathProviderPlatform with MockPlatformInterfaceMixin {
  FakeSandbox(this.root);
  final Directory root;
  String _d(String name) => (Directory('${root.path}/$name')..createSync(recursive: true)).path;

  Directory get files => Directory(_d('files'));
  Directory get cache => Directory(_d('cache'));
  Directory get external => Directory(_d('external'));

  @override
  Future<String?> getApplicationDocumentsPath() async => _d('files');
  @override
  Future<String?> getApplicationSupportPath() async => _d('support');
  @override
  Future<String?> getTemporaryPath() async => _d('cache');
  @override
  Future<String?> getApplicationCachePath() async => _d('cache');
  @override
  Future<String?> getExternalStoragePath() async => _d('external');
  @override
  Future<String?> getDownloadsPath() async => _d('external/Download');

  /// Every file the app has written, relative to the sandbox root.
  List<String> allFiles() => root.listSync(recursive: true).whereType<File>().map((f) => f.path.substring(root.path.length + 1).replaceAll(r'\', '/')).toList()..sort();

  /// True when [needle] appears in any file in the sandbox.
  bool anyFileContains(String needle) {
    for (final f in root.listSync(recursive: true).whereType<File>()) {
      if (String.fromCharCodes(f.readAsBytesSync()).contains(needle)) return true;
    }
    return false;
  }
}

class Harness {
  Harness._(this.api, this.sandbox, this.secure, this.openedFiles);
  final FakeTrustVaultApi api;
  final FakeSandbox sandbox;

  /// The fake Keystore-backed storage: what the app put in secure storage.
  final Map<String, String> secure;

  /// Paths the app asked the system viewer (open_filex) to open.
  final List<String> openedFiles;

  static Future<Harness> create() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final api = FakeTrustVaultApi();
    final root = await Directory.systemTemp.createTemp('tv-sandbox-');
    final sandbox = FakeSandbox(root);
    PathProviderPlatform.instance = sandbox;
    final secure = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(secure);
    SharedPreferences.setMockInitialValues({});
    final opened = <String>[];
    openFileWith = (path) async {
      opened.add(path);
      return OpenResult(type: ResultType.done, message: 'done');
    };
    await Api.I.clearSession();
    Api.I.client = api.client;
    Api.I.baseUrl = 'https://vault.test/api';
    Api.I.releaseMode = true;
    Api.I.onUnauthorized = null;
    Api.I.onMfaRequired = null;
    return Harness._(api, sandbox, secure, opened);
  }

  Future<void> dispose() async {
    await Api.I.clearSession();
    try {
      await sandbox.root.delete(recursive: true);
    } catch (_) {}
  }

  /// The session token the fake server issued last (the cookie value).
  String? get issuedToken => api.sessions.keys.lastOrNull;
}
