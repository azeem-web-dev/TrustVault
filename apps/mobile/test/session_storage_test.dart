// Where the session token lives and what happens to everything local when
// the session ends (sign-out, expiry, ended elsewhere).
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:trustvault/core/api.dart';
import 'package:trustvault/core/local_copies.dart';
import 'package:trustvault/core/session.dart';

import 'support/fake_api.dart';
import 'support/harness.dart';

void main() {
  late Harness h;
  setUp(() async => h = await Harness.create());
  tearDown(() async => h.dispose());

  /// Runs [body] capturing everything printed (print and debugPrint).
  Future<String> captureLogs(Future<void> Function() body) async {
    final out = StringBuffer();
    final oldDebugPrint = debugPrint;
    debugPrint = (String? m, {int? wrapWidth}) => out.writeln(m);
    try {
      await runZoned(body, zoneSpecification: ZoneSpecification(print: (_, _, _, line) => out.writeln(line)));
    } finally {
      debugPrint = oldDebugPrint;
    }
    return out.toString();
  }

  Future<Session> signedIn() async {
    final s = Session();
    await s.start();
    await s.signIn(h.api.viewer.email, h.api.viewer.password);
    expect(s.mfaPending, isTrue);
    await Api.I.post('/auth/mfa/totp/verify', {'code': FakeTrustVaultApi.totpCode});
    await s.refresh();
    expect(s.user?.email, h.api.viewer.email);
    expect(s.mfaPending, isFalse);
    return s;
  }

  test('the token goes only to secure storage: not shared preferences, files or logs', () async {
    late Session s;
    final logs = await captureLogs(() async {
      s = await signedIn();
      await (await SharedPreferences.getInstance()).setString('tv-theme', 'dark');
    });
    final token = h.issuedToken!;
    expect(h.secure, {'session': token});
    final prefs = await SharedPreferences.getInstance();
    for (final k in prefs.getKeys()) {
      expect('${prefs.get(k)}', isNot(contains(token)), reason: 'shared preference $k');
    }
    expect(h.sandbox.anyFileContains(token), isFalse, reason: 'token written to a file');
    expect(logs, isNot(contains(token)));
    expect(logs, isNot(contains(Api.I.csrfToken!)));
    expect(s.user, isNotNull);
  });

  test('a stored session is reused at start-up', () async {
    await signedIn();
    final s2 = Session();
    await s2.start();
    expect(s2.user?.email, h.api.viewer.email);
  });

  test('sign-out: server told (with CSRF), token, CSRF, copies and temp files gone', () async {
    final s = await signedIn();
    final csrf = Api.I.csrfToken;
    await LocalCopies.save('/documents/d-report/download', 'report.txt', [1, 2, 3]);
    final picked = File('${h.sandbox.cache.path}/file_picker/123/upload.pdf')..createSync(recursive: true);
    picked.writeAsStringSync('picked for upload');

    await s.signOut();

    final logout = h.api.requests.lastWhere((r) => r.path == '/auth/logout');
    expect(logout.header('x-csrf-token'), csrf);
    expect(h.api.sessions, isEmpty, reason: 'server-side session must be ended');
    expect(s.user, isNull);
    expect(Api.I.hasSession, isFalse);
    expect(Api.I.csrfToken, isNull);
    expect(h.secure, isEmpty);
    expect(await (await LocalCopies.root()).exists(), isFalse);
    expect(picked.existsSync(), isFalse);
  });

  test('sign-out still wipes the phone when the server cannot be reached', () async {
    final s = await signedIn();
    await LocalCopies.save('/documents/d-report/download', 'report.txt', [1, 2, 3]);
    h.api.offline = true;
    await s.signOut();
    expect(h.secure, isEmpty);
    expect(Api.I.hasSession, isFalse);
    expect(await (await LocalCopies.root()).exists(), isFalse);
  });

  test('an expired/ended session (401 on any request) signs out and wipes', () async {
    final s = await signedIn();
    await LocalCopies.save('/documents/d-report/download', 'report.txt', [1, 2, 3]);
    h.api.endAllSessions();
    await expectLater(Api.I.get('/documents?scope=all&page=1'), throwsA(isA<ApiError>()));
    // onUnauthorized resets asynchronously.
    for (var i = 0; i < 100 && (s.user != null || h.secure.isNotEmpty || await (await LocalCopies.root()).exists()); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(s.user, isNull);
    expect(s.endedNotice, Session.sessionEndedText);
    expect(h.secure, isEmpty);
    expect(await (await LocalCopies.root()).exists(), isFalse);
  });

  test('a stored session the server no longer accepts is dropped at start-up', () async {
    await signedIn();
    h.api.endAllSessions();
    final s2 = Session();
    await s2.start();
    expect(s2.user, isNull);
    expect(h.secure, isEmpty);
  });

  test('password changed / ended elsewhere wipes like sign-out', () async {
    final s = await signedIn();
    await LocalCopies.save('/documents/d-report/download', 'report.txt', [1, 2, 3]);
    await s.endedElsewhere();
    expect(h.secure, isEmpty);
    expect(await (await LocalCopies.root()).exists(), isFalse);
  });

  test('a wrong password stores nothing', () async {
    final s = Session();
    await s.start();
    await expectLater(s.signIn(h.api.viewer.email, 'wrong'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 401)));
    expect(h.secure, isEmpty);
    expect(Api.I.hasSession, isFalse);
  });
}
