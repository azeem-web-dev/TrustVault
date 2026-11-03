// API client behaviour that the server's security depends on: cookie
// session, CSRF on every state-changing request, 401/403 hand-off to the
// session layer, refusal of plain HTTP in release builds.
import 'package:flutter_test/flutter_test.dart';
import 'package:trustvault/core/api.dart';
import 'package:trustvault/core/transport_policy.dart';

import 'support/fake_api.dart';
import 'support/harness.dart';

void main() {
  late Harness h;
  setUp(() async => h = await Harness.create());
  tearDown(() async => h.dispose());

  Future<void> signIn({bool mfa = true}) async {
    final u = h.api.viewer..totp = mfa;
    await Api.I.post('/auth/login', {'email': u.email, 'password': u.password});
    if (mfa) await Api.I.post('/auth/mfa/totp/verify', {'code': FakeTrustVaultApi.totpCode});
  }

  group('session cookie', () {
    test('sign-in keeps the cookie value and sends it back; no Origin header', () async {
      await signIn(mfa: false);
      expect(Api.I.hasSession, isTrue);
      await Api.I.get('/documents?scope=all&page=1');
      final r = h.api.requests.last;
      expect(r.header('cookie'), '$sessionCookie=${h.issuedToken}');
      expect(r.header('origin'), isNull);
      expect(r.header('user-agent'), 'TrustVault Android app');
    });

    test('the second factor rotates the session; the old token is dropped', () async {
      final u = h.api.viewer;
      await Api.I.post('/auth/login', {'email': u.email, 'password': u.password});
      final before = h.secure['session'];
      await Api.I.post('/auth/mfa/totp/verify', {'code': FakeTrustVaultApi.totpCode});
      expect(h.secure['session'], isNot(before));
      expect(h.secure['session'], h.issuedToken);
      expect(h.api.sessions.containsKey(before), isFalse);
    });

    test('an empty Set-Cookie from the server (sign-out) clears the stored session', () async {
      await signIn();
      await Api.I.post('/auth/logout');
      expect(Api.I.hasSession, isFalse);
      expect(Api.I.csrfToken, isNull);
      expect(h.secure.containsKey('session'), isFalse);
    });
  });

  group('CSRF', () {
    test('every state-changing request carries the in-memory CSRF token; GET does not', () async {
      await signIn();
      final csrf = Api.I.csrfToken;
      expect(csrf, isNotNull);
      for (final call in [
        () => Api.I.post('/documents/x/restore'),
        () => Api.I.patch('/documents/x', {'title': 't'}),
        () => Api.I.put('/documents/x/access', {'grants': []}),
        () => Api.I.delete('/documents/x'),
        () => Api.I.upload('/documents', bytes: [1, 2, 3], fileName: 'a.txt', fields: {'title': 't'}),
      ]) {
        await expectLater(call(), throwsA(isA<ApiError>().having((e) => e.status, 'status', 404)));
      }
      final mutating = h.api.mutating.where((r) => !r.path.startsWith('/auth/')).toList();
      expect(mutating, hasLength(5));
      for (final r in mutating) {
        expect(r.header('x-csrf-token'), csrf, reason: '$r');
      }
      await Api.I.get('/documents?scope=all&page=1');
      expect(h.api.requests.last.header('x-csrf-token'), isNull);
    });

    test('the CSRF token is never written to storage', () async {
      await signIn();
      expect(h.secure.values, isNot(contains(Api.I.csrfToken)));
      expect(h.sandbox.anyFileContains(Api.I.csrfToken!), isFalse);
    });

    test('without the CSRF token the server refuses the change (403)', () async {
      await signIn();
      Api.I.csrfToken = null;
      await expectLater(Api.I.post('/documents/d-report/restore'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 403).having((e) => e.code, 'code', 'csrf')));
    });
  });

  group('401 / 403 hand-off', () {
    test('401 calls onUnauthorized (the session layer signs out and wipes)', () async {
      await signIn();
      var calls = 0;
      Api.I.onUnauthorized = () => calls++;
      h.api.endAllSessions();
      await expectLater(Api.I.get('/documents?scope=all&page=1'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 401)));
      expect(calls, 1);
    });

    test('403 mfa_required calls onMfaRequired', () async {
      final u = h.api.viewer;
      await Api.I.post('/auth/login', {'email': u.email, 'password': u.password});
      var calls = 0;
      Api.I.onMfaRequired = () => calls++;
      await expectLater(Api.I.get('/documents?scope=all&page=1'), throwsA(isA<ApiError>().having((e) => e.code, 'code', 'mfa_required')));
      expect(calls, 1);
    });

    test('a revoked document is a 404 with no detail, for reads and downloads', () async {
      await signIn();
      await Api.I.get('/documents/d-report');
      h.api.revoke('d-report', h.api.viewer.id);
      await expectLater(Api.I.get('/documents/d-report'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 404)));
      await expectLater(Api.I.download('/documents/d-report/download'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 404)));
    });

    test('a network failure is reported without crashing (status 0)', () async {
      await signIn();
      h.api.offline = true;
      await expectLater(Api.I.get('/documents?scope=all&page=1'), throwsA(isA<ApiError>().having((e) => e.status, 'status', 0)));
    });
  });

  group('transport policy', () {
    test('release builds refuse plain HTTP before any request is sent', () async {
      Api.I.baseUrl = 'http://vault.test/api';
      Api.I.releaseMode = true;
      await expectLater(Api.I.post('/auth/login', {'email': 'a', 'password': 'b'}), throwsA(isA<ApiError>().having((e) => e.code, 'code', 'insecure_origin')));
      await expectLater(Api.I.download('/documents/d-report/download'), throwsA(isA<ApiError>().having((e) => e.code, 'code', 'insecure_origin')));
      await expectLater(Api.I.upload('/documents', bytes: [1], fileName: 'a'), throwsA(isA<ApiError>().having((e) => e.code, 'code', 'insecure_origin')));
      expect(h.api.requests, isEmpty);
    });

    test('release: localhost over HTTP is refused too', () {
      expect(insecureOriginReason('http://localhost:4100/api', release: true), isNotNull);
      expect(insecureOriginReason('http://10.0.2.2:4100/api', release: true), isNotNull);
    });

    test('HTTPS is allowed in every build', () {
      expect(insecureOriginReason('https://vault.rayyanazeem.cloud/api', release: true), isNull);
      expect(insecureOriginReason('https://vault.rayyanazeem.cloud/api', release: false), isNull);
    });

    test('debug/profile: HTTP only to loopback or the emulator host', () {
      expect(insecureOriginReason('http://localhost:4100/api', release: false), isNull);
      expect(insecureOriginReason('http://127.0.0.1:4100/api', release: false), isNull);
      expect(insecureOriginReason('http://10.0.2.2:4100/api', release: false), isNull);
      expect(insecureOriginReason('http://192.168.1.20:4100/api', release: false), isNotNull);
      expect(insecureOriginReason('http://vault.rayyanazeem.cloud/api', release: false), isNotNull);
    });

    test('other schemes, credentials in the URL and junk are refused', () {
      expect(insecureOriginReason('ftp://vault.test/api', release: false), isNotNull);
      expect(insecureOriginReason('https://user:pw@vault.test/api', release: true), isNotNull);
      expect(insecureOriginReason('not a url', release: true), isNotNull);
    });

    test('the compiled-in default origin is HTTPS', () {
      expect(Api.origin, startsWith('https://'));
      expect(insecureOriginReason(Api.base, release: true), isNull);
    });
  });
}
