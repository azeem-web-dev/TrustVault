// A small in-memory stand-in for the TrustVault API (apps/api), used by the
// unit/widget tests (through [FakeTrustVaultApi.client]) and by the on-device
// integration tests (through [FakeTrustVaultApi.serve], a real HTTP server on
// the phone's loopback interface). It copies the real API's rules that matter
// to the app's security behaviour:
//
//  * the session lives in the `__Host-tv_session` cookie, rotated when the
//    second factor is passed, cleared (empty value) on sign-out;
//  * every state-changing request needs the session's `X-CSRF-Token`;
//  * an account with a second factor gets `403 mfa_required` until it is used;
//  * a document you cannot see (never shared, revoked, share expired, deleted)
//    is a plain 404, the same as one that does not exist;
//  * an ended or expired session is a 401.
//
// It is NOT the real API and must never be pointed at a real server.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const sessionCookie = '__Host-tv_session';

class FakeUser {
  FakeUser({required this.id, required this.email, required this.displayName, required this.role, required this.password, this.totp = false});
  final String id;
  final String email;
  final String displayName;
  final String role;
  String password;
  bool totp;
  Map<String, dynamic> toJson() => {'id': id, 'email': email, 'displayName': displayName, 'role': role};
}

class FakeSession {
  FakeSession(this.userId, this.csrf, {this.mfaDone = false});
  final String userId;
  final String csrf;
  bool mfaDone;
}

class FakeGrant {
  FakeGrant(this.userId, {this.level = 'READ', this.expiresAt});
  final String userId;
  final String level;
  DateTime? expiresAt;
  bool get live => expiresAt == null || expiresAt!.isAfter(DateTime.now());
}

class FakeDoc {
  FakeDoc({required this.id, required this.title, required this.ownerId, required this.fileName, required this.bytes, this.category = 'Finance'});
  final String id;
  final String title;
  final String ownerId;
  final String fileName;
  final List<int> bytes;
  final String category;
  final grants = <String, FakeGrant>{};
  bool deleted = false;
}

/// One request as the fake server saw it.
class SeenRequest {
  SeenRequest(this.method, this.path, this.headers, this.body);
  final String method;
  final String path; // without the /api prefix, with the query string
  final Map<String, String> headers; // lower-case names
  final String body;
  String? header(String name) => headers[name.toLowerCase()];
  @override
  String toString() => '$method $path';
}

class FakeReply {
  FakeReply(this.status, this.body, {this.headers = const {}});
  final int status;
  final List<int> body;
  final Map<String, String> headers;
}

class FakeTrustVaultApi {
  FakeTrustVaultApi() {
    viewer = addUser(FakeUser(id: 'u-viewer', email: 'viewer@example.test', displayName: 'Vera Viewer', role: 'VIEWER', password: 'correct horse battery', totp: true));
    owner = addUser(FakeUser(id: 'u-owner', email: 'owner@example.test', displayName: 'Omar Owner', role: 'OWNER', password: 'owner password long'));
    doc = addDoc(FakeDoc(id: 'd-report', title: 'Quarterly report', ownerId: owner.id, fileName: 'quarterly-report.txt', bytes: utf8.encode('TV-SECRET-PAYLOAD quarterly numbers')));
    doc.grants[viewer.id] = FakeGrant(viewer.id);
  }

  /// The second-factor code the fake accepts.
  static const totpCode = '123456';

  late final FakeUser viewer;
  late final FakeUser owner;
  late final FakeDoc doc;

  final users = <String, FakeUser>{};
  final docs = <String, FakeDoc>{};
  final sessions = <String, FakeSession>{};
  final requests = <SeenRequest>[];
  final _rand = Random.secure();

  /// When set, every request fails as if the network were down.
  bool offline = false;

  FakeUser addUser(FakeUser u) => users[u.id] = u;
  FakeDoc addDoc(FakeDoc d) => docs[d.id] = d;

  /// The owner takes a share away.
  void revoke(String docId, String userId) => docs[docId]!.grants.remove(userId);

  /// A share whose end date has passed.
  void expireShare(String docId, String userId) => docs[docId]!.grants[userId]!.expiresAt = DateTime.now().subtract(const Duration(minutes: 1));

  /// Session expiry, password change elsewhere, admin deactivation: every
  /// session ends and the next request is a 401.
  void endAllSessions() => sessions.clear();

  Iterable<SeenRequest> get mutating => requests.where((r) => r.method != 'GET' && r.method != 'HEAD');

  String _token() => base64Url.encode(List.generate(32, (_) => _rand.nextInt(256))).replaceAll('=', '');

  // ------------------------------------------------------------------ adapters

  /// An `http.Client` that answers from this fake (no sockets).
  http.Client get client => MockClient((req) async {
    if (offline) throw const SocketException('offline (fake)');
    final r = await handle(req.method, req.url, req.headers, req.bodyBytes);
    return http.Response.bytes(r.body, r.status, headers: r.headers, request: req);
  });

  /// A real HTTP server on 127.0.0.1 (for the on-device integration tests,
  /// where the app makes real socket connections). Closes with [HttpServer.close].
  Future<HttpServer> serve({int port = 0}) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    server.listen((req) async {
      final body = await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
      final headers = <String, String>{};
      req.headers.forEach((name, values) => headers[name] = values.join(', '));
      final r = await handle(req.method, req.uri, headers, body);
      req.response.statusCode = r.status;
      r.headers.forEach(req.response.headers.set);
      req.response.add(r.body);
      await req.response.close();
    });
    return server;
  }

  // -------------------------------------------------------------------- router

  Future<FakeReply> handle(String method, Uri url, Map<String, String> rawHeaders, List<int> bodyBytes) async {
    final headers = {for (final e in rawHeaders.entries) e.key.toLowerCase(): e.value};
    var path = url.path;
    if (!path.startsWith('/api/')) return _json(404, {'message': 'Not found'});
    path = path.substring(4);
    final full = url.hasQuery ? '$path?${url.query}' : path;
    final bodyText = _isMultipart(headers) ? '<multipart ${bodyBytes.length} bytes>' : utf8.decode(bodyBytes, allowMalformed: true);
    requests.add(SeenRequest(method, full, headers, bodyText));
    Map<String, dynamic> body() => bodyText.isEmpty ? {} : (jsonDecode(bodyText) as Map).cast<String, dynamic>();

    if (method == 'POST' && path == '/auth/login') return _login(body());

    final token = _cookie(headers['cookie']);
    final s = token == null ? null : sessions[token];
    if (s == null) return _json(401, {'message': 'Please sign in'});
    final me = users[s.userId]!;

    if (method != 'GET' && method != 'HEAD' && headers['x-csrf-token'] != s.csrf) {
      return _json(403, {'message': 'Missing or wrong CSRF token', 'code': 'csrf'});
    }

    // Allowed before the second factor ("partial" auth), like the real API.
    if (method == 'GET' && path == '/auth/me') return _json(200, _me(me, s));
    if (method == 'GET' && path == '/auth/mfa') return _json(200, {'required': me.totp, 'satisfied': s.mfaDone, 'totp': me.totp, 'passkeys': <Object>[]});
    if (method == 'POST' && path == '/auth/mfa/totp/verify') {
      if (body()['code'] != totpCode) return _json(400, {'message': 'That code is not right'});
      sessions.remove(token);
      final next = _token();
      final ns = sessions[next] = FakeSession(me.id, _token(), mfaDone: true);
      return _json(200, {..._me(me, ns), 'csrfToken': ns.csrf}, cookie: next);
    }
    if (method == 'POST' && path == '/auth/logout') {
      sessions.remove(token);
      return FakeReply(204, const [], headers: {'set-cookie': '$sessionCookie=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict'});
    }

    if (me.totp && !s.mfaDone) return _json(403, {'message': 'Second factor required', 'code': 'mfa_required'});

    if (method == 'GET' && path == '/documents') return _json(200, _list(me));
    if (method == 'GET' && path == '/documents/categories') return _json(200, {'categories': ['Finance', 'Legal']});
    if (method == 'GET' && path == '/folders') return _json(200, {'folders': <Object>[]});

    final m = RegExp(r'^/documents/([^/]+)(/.*)?$').firstMatch(path);
    if (m != null) {
      final d = docs[m.group(1)];
      final level = d == null ? null : _level(d, me);
      if (d == null || level == null) return _json(404, {'message': 'Document not found'});
      final rest = m.group(2) ?? '';
      if (method == 'GET' && rest.isEmpty) return _json(200, _detail(d, me, level));
      if (method == 'GET' && (rest == '/download' || RegExp(r'^/versions/\d+/download$').hasMatch(rest))) {
        return FakeReply(200, d.bytes, headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="${d.fileName}"',
          'cache-control': 'no-store',
        });
      }
    }
    return _json(404, {'message': 'Not found'});
  }

  // ------------------------------------------------------------------ handlers

  FakeReply _login(Map<String, dynamic> b) {
    final u = users.values.where((u) => u.email == b['email']).firstOrNull;
    if (u == null || u.password != b['password']) return _json(401, {'message': 'Wrong email or password'});
    final token = _token();
    final s = sessions[token] = FakeSession(u.id, _token(), mfaDone: !u.totp);
    return _json(200, {'user': u.toJson(), 'csrfToken': s.csrf, 'mfaRequired': u.totp, 'mfaEnrolled': u.totp, 'mfaMethods': u.totp ? ['totp'] : <String>[]}, cookie: token);
  }

  Map<String, dynamic> _me(FakeUser u, FakeSession s) => {
    'user': u.toJson(),
    'csrfToken': s.csrf,
    'mfaRequired': u.totp,
    'mfaSatisfied': s.mfaDone,
    'mfaEnrolled': u.totp,
  };

  String? _level(FakeDoc d, FakeUser u) {
    if (d.deleted) return null;
    if (d.ownerId == u.id) return 'OWNER';
    final g = d.grants[u.id];
    return g != null && g.live ? g.level : null;
  }

  Map<String, dynamic> _item(FakeDoc d, FakeUser me, String level) {
    final o = users[d.ownerId]!;
    const at = '2026-10-01T09:00:00.000Z';
    return {
      'id': d.id, 'title': d.title, 'category': d.category, 'description': null, 'status': 'ACTIVE',
      'createdAt': at, 'updatedAt': at, 'deletedAt': null,
      'owner': {'id': o.id, 'displayName': o.displayName, 'email': o.email},
      'isOwner': d.ownerId == me.id, 'myAccess': level, 'folderId': null,
      'current': {'versionNo': 1, 'fileName': d.fileName, 'mimeType': 'text/plain', 'sizeBytes': d.bytes.length, 'createdAt': at},
    };
  }

  Map<String, dynamic> _list(FakeUser me) {
    final rows = [
      for (final d in docs.values)
        if (_level(d, me) case final l?) _item(d, me, l),
    ];
    return {'total': rows.length, 'page': 1, 'pageSize': 20, 'documents': rows};
  }

  Map<String, dynamic> _detail(FakeDoc d, FakeUser me, String level) => {
    ..._item(d, me, level),
    'folder': null,
    'versions': [
      {'versionNo': 1, 'fileName': d.fileName, 'mimeType': 'text/plain', 'sizeBytes': d.bytes.length, 'createdAt': '2026-10-01T09:00:00.000Z', 'sha256': '00', 'uploadedBy': users[d.ownerId]!.displayName, 'quarantine': null},
    ],
  };

  // ------------------------------------------------------------------- helpers

  static bool _isMultipart(Map<String, String> h) => (h['content-type'] ?? '').startsWith('multipart/');

  static String? _cookie(String? header) {
    if (header == null) return null;
    final m = RegExp('$sessionCookie=([^;]*)').firstMatch(header);
    final v = m?.group(1);
    return v == null || v.isEmpty ? null : v;
  }

  static FakeReply _json(int status, Object body, {String? cookie}) => FakeReply(
    status,
    Uint8List.fromList(utf8.encode(jsonEncode(body))),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      if (cookie != null) 'set-cookie': '$sessionCookie=$cookie; Path=/; HttpOnly; Secure; SameSite=Strict',
    },
  );
}
