// On-device security flows: the real app (real Keystore storage, real files,
// real HTTP sockets) against the fake API, which runs inside the test on the
// device's loopback interface (http://127.0.0.1:<port>; debug builds allow
// cleartext to loopback only, see lib/core/transport_policy.dart).
//
//   cd apps/mobile
//   flutter test integration_test -d emulator-5554
//
// Nothing here talks to a real server.
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:trustvault/core/api.dart';
import 'package:trustvault/core/local_copies.dart';
import 'package:trustvault/main.dart' as app;
import 'package:trustvault/widgets/files.dart';

import '../test/support/fake_api.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late FakeTrustVaultApi api;
  late HttpServer server;
  late String marker; // random text inside the document; never in the test binary
  final opened = <String>[];

  setUp(() async {
    api = FakeTrustVaultApi();
    marker = 'TVDOC-${List.generate(16, (_) => Random.secure().nextInt(16).toRadixString(16)).join()}';
    api.docs.remove(api.doc.id);
    final d = api.addDoc(FakeDoc(id: 'd-board', title: 'Board minutes', ownerId: api.owner.id, fileName: 'board-minutes.txt', bytes: '$marker confidential'.codeUnits));
    d.grants[api.viewer.id] = FakeGrant(api.viewer.id);
    server = await api.serve();
    Api.I.client = http.Client();
    Api.I.baseUrl = 'http://127.0.0.1:${server.port}/api';
    opened.clear();
    openFileWith = (path) async {
      opened.add(path);
      return OpenResult(type: ResultType.done, message: 'done');
    };
    // Start every test from a clean phone.
    await Api.I.clearSession();
    await LocalCopies.wipeAll();
    await (await SharedPreferences.getInstance()).clear();
  });

  tearDown(() async {
    await server.close(force: true);
  });

  Future<void> waitFor(WidgetTester tester, bool Function() done, {String? what, int seconds = 20}) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (!done()) {
      if (DateTime.now().isAfter(end)) fail('timed out waiting for ${what ?? 'condition'}');
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  bool shows(String text) => find.text(text).evaluate().isNotEmpty;

  Future<void> tap(WidgetTester tester, Finder f) async {
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.tap(f);
    await tester.pump();
  }

  Future<void> startApp(WidgetTester tester) async {
    await app.main();
    await tester.pump();
  }

  Future<void> signIn(WidgetTester tester) async {
    await startApp(tester);
    await waitFor(tester, () => shows('Welcome back'), what: 'sign-in screen');
    await tester.enterText(find.byType(TextFormField).at(0), api.viewer.email);
    await tester.enterText(find.byType(TextFormField).at(1), api.viewer.password);
    await tap(tester, find.text('Sign in'));
    await waitFor(tester, () => shows('Confirm it’s you'), what: 'MFA prompt');
    expect(shows('Board minutes'), isFalse, reason: 'nothing is reachable before the second factor');
    await tester.enterText(find.byType(TextField).last, FakeTrustVaultApi.totpCode);
    await tester.pump();
    await tap(tester, find.text('Verify'));
    await waitFor(tester, () => shows('Board minutes'), what: 'document list');
  }

  Future<void> openDoc(WidgetTester tester) async {
    await tap(tester, find.text('Board minutes').first);
    await waitFor(tester, () => find.textContaining('Download  ·').evaluate().isNotEmpty || shows('Nothing to see here'), what: 'document page');
  }

  Future<File> download(WidgetTester tester) async {
    final before = opened.length;
    await tap(tester, find.textContaining('Download  ·'));
    await waitFor(tester, () => opened.length > before, what: 'download');
    return File(opened.last);
  }

  Future<void> back(WidgetTester tester) async {
    app.navigatorKey.currentState!.pop();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<Directory> dataDir() async => (await getApplicationSupportDirectory()).parent;

  /// Every file under the app's private data directory that contains [needle].
  Future<List<String>> filesContaining(String needle) async {
    final hits = <String>[];
    final bytes = needle.codeUnits;
    await for (final e in (await dataDir()).list(recursive: true, followLinks: false)) {
      if (e is! File) continue;
      try {
        if (e.lengthSync() > 64 * 1024 * 1024) continue;
        final data = await e.readAsBytes();
        if (_indexOf(data, bytes) >= 0) hits.add(e.path);
      } catch (_) {}
    }
    return hits;
  }

  testWidgets('sign-in → MFA → open → download → revoke: next open refused, copy gone', (tester) async {
    await signIn(tester);
    await openDoc(tester);
    final copy = await download(tester);
    final docs = (await getApplicationDocumentsDirectory()).path;
    expect(copy.path, startsWith('$docs/downloads/d-board/'), reason: 'app-private storage only');
    expect(copy.path, isNot(contains('/sdcard')));
    expect(copy.readAsStringSync(), contains(marker));
    await back(tester);

    api.revoke('d-board', api.viewer.id);
    await openDoc(tester);
    await waitFor(tester, () => shows('Nothing to see here'), what: 'refusal');
    await waitFor(tester, () => !copy.existsSync(), what: 'copy removed');
    expect(await filesContaining(marker), isEmpty, reason: 'no plaintext of a revoked document anywhere in app data');
  });

  testWidgets('an expired share is refused and its copy removed', (tester) async {
    await signIn(tester);
    await openDoc(tester);
    final copy = await download(tester);
    await back(tester);
    api.expireShare('d-board', api.viewer.id);
    await openDoc(tester);
    await waitFor(tester, () => shows('Nothing to see here'), what: 'refusal');
    await waitFor(tester, () => !copy.existsSync(), what: 'copy removed');
  });

  testWidgets('the token is only in Keystore-encrypted storage; never plaintext on disk', (tester) async {
    await signIn(tester);
    final token = api.sessions.keys.single;
    expect(await const FlutterSecureStorage().read(key: 'session'), token);
    final prefs = await SharedPreferences.getInstance();
    for (final k in prefs.getKeys()) {
      expect('${prefs.get(k)}', isNot(contains(token)), reason: k);
    }
    expect(await filesContaining(token), isEmpty, reason: 'the token must not appear in plaintext in any app file');
    expect(await filesContaining(Api.I.csrfToken!), isEmpty, reason: 'the CSRF token stays in memory');
  });

  testWidgets('a cold start reuses the stored session (no sign-in screen)', (tester) async {
    await signIn(tester);
    await startApp(tester);
    await waitFor(tester, () => shows('Board minutes'), what: 'home after restart');
    expect(shows('Welcome back'), isFalse);
  });

  testWidgets('sign-out wipes the token, copies and temp files', (tester) async {
    await signIn(tester);
    await openDoc(tester);
    final copy = await download(tester);
    final picked = File('${(await getTemporaryDirectory()).path}/file_picker/1/upload-$marker.txt')
      ..createSync(recursive: true)
      ..writeAsStringSync(marker);
    final token = api.sessions.keys.single;
    await back(tester);
    await tap(tester, find.byTooltip('Account menu'));
    await waitFor(tester, () => shows('Sign out'), what: 'menu');
    await tap(tester, find.text('Sign out').last);
    await waitFor(tester, () => shows('Welcome back'), what: 'sign-in screen');
    await waitFor(tester, () => !copy.existsSync() && !picked.existsSync(), what: 'wipe');
    expect(api.sessions, isEmpty, reason: 'the server session was ended');
    expect(await const FlutterSecureStorage().read(key: 'session'), isNull);
    expect(await filesContaining(marker), isEmpty);
    expect(await filesContaining(token), isEmpty);
  });

  testWidgets('backgrounding: session kept while away; ended elsewhere → signed out and wiped on return', (tester) async {
    await signIn(tester);
    await openDoc(tester);
    final copy = await download(tester);

    // Background and return with the document on screen. This branch has no
    // app lock, so the session is kept (mfa-advanced adds the lock).
    for (final s in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
      binding.handleAppLifecycleStateChanged(s);
      await tester.pump();
    }
    api.endAllSessions(); // e.g. the password was changed on the website meanwhile
    for (final s in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
      binding.handleAppLifecycleStateChanged(s);
      await tester.pump();
    }
    expect(find.textContaining('Download  ·'), findsOneWidget);

    // The next request gets a 401: back to sign-in, everything wiped.
    await tap(tester, find.textContaining('Download  ·'));
    await waitFor(tester, () => shows('Welcome back'), what: 'sign-in after 401');
    await waitFor(tester, () => !copy.existsSync(), what: 'copy wiped');
    expect(await const FlutterSecureStorage().read(key: 'session'), isNull);
    expect(await filesContaining(marker), isEmpty);
  });

  testWidgets('wrong second-factor code: stays on the MFA screen, documents unreachable', (tester) async {
    await startApp(tester);
    await waitFor(tester, () => shows('Welcome back'), what: 'sign-in screen');
    await tester.enterText(find.byType(TextFormField).at(0), api.viewer.email);
    await tester.enterText(find.byType(TextFormField).at(1), api.viewer.password);
    await tap(tester, find.text('Sign in'));
    await waitFor(tester, () => shows('Confirm it’s you'), what: 'MFA prompt');
    await tester.enterText(find.byType(TextField).last, '000000');
    await tester.pump();
    await tap(tester, find.text('Verify'));
    await waitFor(tester, () => shows('That code is not right'), what: 'error');
    final r = await http.get(Uri.parse('${Api.I.baseUrl}/documents?scope=all&page=1'), headers: {'Cookie': '$sessionCookie=${api.sessions.keys.single}'});
    expect(r.statusCode, 403, reason: 'the half-signed-in session cannot list documents');
    // Leave the app signed out for the next test.
    await tap(tester, find.text('Sign out').last);
    await waitFor(tester, () => shows('Welcome back'), what: 'signed out');
  });
}

int _indexOf(List<int> hay, List<int> needle) {
  if (needle.isEmpty || hay.length < needle.length) return -1;
  final first = needle[0];
  outer:
  for (var i = 0; i <= hay.length - needle.length; i++) {
    if (hay[i] != first) continue;
    for (var j = 1; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
