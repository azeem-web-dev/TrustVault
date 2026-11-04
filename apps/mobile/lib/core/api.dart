import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'transport_policy.dart';

/// Thin client for the TrustVault API, mirroring apps/web/src/lib/api.ts.
///
/// The browser keeps the session in an HttpOnly cookie; here the same cookie
/// value is kept in the Android Keystore-backed secure storage and sent by
/// hand. The CSRF token stays in memory only, exactly like the web app.
/// Native requests carry no Origin header, which the API's origin check
/// accepts (it only refuses a *different* browser origin).
class ApiError implements Exception {
  ApiError(this.status, this.message, {this.code});
  final int status;
  final String message;
  final String? code;
  @override
  String toString() => message;
}

class Download {
  Download(this.bytes, this.fileName);
  final List<int> bytes;
  final String fileName;
}

class Api {
  Api._();
  static final Api I = Api._();

  // Live server by default; a debug build can point at a local API with
  // --dart-define=TV_ORIGIN=http://localhost:4100 (plus adb reverse).
  static const origin = String.fromEnvironment('TV_ORIGIN', defaultValue: 'https://vault.rayyanazeem.cloud');
  static const base = '$origin/api';
  static const _cookieName = '__Host-tv_session';
  /// "This phone signed in to this account before": lets the owner past the
  /// per-account throttle a stranger can trigger by guessing (THREATS.md
  /// S27). Not a credential; kept across sign-outs, like a browser cookie.
  static const _deviceCookieName = '__Host-tv_device';
  static const _userAgent = 'TrustVault Android app';

  final _store = const FlutterSecureStorage();
  http.Client _client = http.Client();

  /// Test seam: route every request through [client] (a fake API in tests).
  @visibleForTesting
  set client(http.Client client) => _client = client;

  /// Test seam: the base URL and build mode the transport policy sees.
  @visibleForTesting
  String baseUrl = base;
  @visibleForTesting
  bool releaseMode = kReleaseMode;

  /// Builds a request URL, refusing plain HTTP in a release build even if
  /// TV_ORIGIN was set to one (the manifest also blocks cleartext).
  Uri _uri(String path) {
    final problem = insecureOriginReason(baseUrl, release: releaseMode);
    if (problem != null) throw ApiError(0, problem, code: 'insecure_origin');
    return Uri.parse('$baseUrl$path');
  }
  String? _session;
  String? _device;
  String? csrfToken;

  /// Set by the session layer.
  void Function()? onUnauthorized;
  void Function()? onMfaRequired;

  /// Asks the user for a fresh second factor when the API answers 403
  /// `step_up_required` before a risky action (THREATS.md S20). Resolves true
  /// once POST /auth/mfa/step-up succeeded; the request is then sent again, once.
  Future<bool> Function()? onStepUp;

  Future<void> init() async {
    try {
      _session = await _store.read(key: 'session');
      _device = await _store.read(key: 'device');
    } catch (_) {
      _session = null;
    }
  }

  bool get hasSession => _session != null && _session!.isNotEmpty;

  Future<void> clearSession() async {
    _session = null;
    csrfToken = null;
    try {
      await _store.delete(key: 'session');
    } catch (_) {}
  }

  Map<String, String> _headers(String method, {bool json = true}) => {
    'Accept': 'application/json',
    'User-Agent': _userAgent,
    if (json) 'Content-Type': 'application/json',
    if (_session != null || _device != null)
      'Cookie': [if (_session != null) '$_cookieName=$_session', if (_device != null) '$_deviceCookieName=$_device'].join('; '),
    if (method != 'GET' && csrfToken != null) 'X-CSRF-Token': csrfToken!,
  };

  Future<void> _captureCookie(http.BaseResponse res) async {
    final raw = res.headers['set-cookie'];
    if (raw == null) return;
    final d = RegExp('$_deviceCookieName=([^;,]*)').firstMatch(raw);
    if (d != null && (d.group(1) ?? '').isNotEmpty && d.group(1) != _device) {
      _device = d.group(1);
      try {
        await _store.write(key: 'device', value: _device!);
      } catch (_) {}
    }
    final m = RegExp('$_cookieName=([^;,]*)').firstMatch(raw);
    if (m == null) return;
    final value = m.group(1) ?? '';
    if (value.isEmpty) {
      await clearSession();
    } else if (value != _session) {
      _session = value;
      try {
        await _store.write(key: 'session', value: value);
      } catch (_) {}
    }
  }

  /// Paths where a 401 means "that code or password was wrong", not "your
  /// session is over": the user must stay where they are to try again.
  static bool _isCredentialCheck(String path) =>
      path.startsWith('/auth/login') || path.startsWith('/auth/mfa/') || path.startsWith('/auth/password');

  /// Whether a 401 really ends the session (so the session layer may wipe
  /// the phone). A wrong second-factor code, failed passkey or wrong current
  /// password is an ordinary input mistake and must not sign the user out.
  @visibleForTesting
  static bool endsSession(String? path, String? code) {
    if (code == 'session_required') return true;
    if (code == 'wrong_code' || code == 'code_expired') return false;
    if (path != null && _isCredentialCheck(path)) return false;
    return true;
  }

  Future<dynamic> _finish(http.Response res, [String? path]) async {
    await _captureCookie(res);
    if (res.statusCode == 204) return null;
    dynamic data;
    try {
      data = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      data = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final map = data is Map ? data : const {};
      final code = map['code'] is String ? map['code'] as String : null;
      if (res.statusCode == 401 && endsSession(path, code)) onUnauthorized?.call();
      if (res.statusCode == 403 && (code == 'mfa_required' || code == 'mfa_enrolment_required')) onMfaRequired?.call();
      final issues = map['issues'];
      String message;
      if (issues is List && issues.isNotEmpty) {
        message = issues.map((i) => i is Map ? '${i['message']}' : '$i').join('; ');
      } else if (map['message'] is String) {
        message = map['message'] as String;
      } else if (map['message'] is List) {
        message = (map['message'] as List).join('; ');
      } else {
        message = 'Request failed (${res.statusCode})';
      }
      throw ApiError(res.statusCode, message, code: code);
    }
    // Sign-in steps that rotate the session also rotate the CSRF token.
    if (data is Map && data['csrfToken'] is String) csrfToken = data['csrfToken'] as String;
    return data;
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    try {
      return await _sendOnce(method, path, body);
    } on ApiError catch (e) {
      final ask = onStepUp;
      if (e.status == 403 && e.code == 'step_up_required' && ask != null && await ask()) {
        return _sendOnce(method, path, body);
      }
      rethrow;
    }
  }

  Future<dynamic> _sendOnce(String method, String path, [Object? body]) async {
    final req = http.Request(method, _uri(path))..headers.addAll(_headers(method, json: body != null));
    if (body != null) req.body = jsonEncode(body);
    try {
      final res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 30))).timeout(const Duration(seconds: 60));
      return await _finish(res, path);
    } catch (e) {
      throw _networkError(e);
    }
  }

  /// Maps transport failures (offline, timeout, TLS, dropped connection) to
  /// ApiError(0) so every caller sees one error type; anything else
  /// (including an ApiError from the server) passes through unchanged.
  static Object _networkError(Object e) {
    if (e is ApiError) return e;
    if (e is SocketException) return ApiError(0, 'Could not reach the server. Check your connection.');
    if (e is TimeoutException) return ApiError(0, 'The server took too long to answer. Try again.');
    if (e is HandshakeException) return ApiError(0, 'Secure connection failed.');
    if (e is HttpException || e is http.ClientException) return ApiError(0, 'Could not reach the server.');
    return e;
  }

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body ?? <String, dynamic>{});
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body);
  Future<dynamic> put(String path, Object body) => _send('PUT', path, body);
  Future<dynamic> delete(String path) => _send('DELETE', path);

  /// Multipart upload (new document or new version).
  Future<dynamic> upload(String path, {required List<int> bytes, required String fileName, Map<String, String> fields = const {}}) async {
    final req = http.MultipartRequest('POST', _uri(path))
      ..headers.addAll(_headers('POST', json: false))
      ..fields.addAll(fields)
      ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: fileName));
    try {
      final res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(minutes: 3))).timeout(const Duration(minutes: 3));
      return await _finish(res, path);
    } catch (e) {
      throw _networkError(e);
    }
  }

  /// Fetches a file the API streams as an attachment.
  Future<Download> download(String path, {String fallbackName = 'download'}) async {
    final req = http.Request('GET', _uri(path))..headers.addAll(_headers('GET', json: false)..remove('Accept'));
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(minutes: 3))).timeout(const Duration(minutes: 3));
    } catch (e) {
      throw _networkError(e);
    }
    if (res.statusCode != 200) {
      await _finish(res, path);
      throw ApiError(res.statusCode, 'Download failed (${res.statusCode})');
    }
    await _captureCookie(res);
    return Download(res.bodyBytes, _fileName(res.headers['content-disposition']) ?? fallbackName);
  }

  static String? _fileName(String? disposition) {
    if (disposition == null) return null;
    final star = RegExp(r"filename\*=UTF-8''([^;]+)", caseSensitive: false).firstMatch(disposition);
    if (star != null) return Uri.decodeComponent(star.group(1)!);
    final plain = RegExp(r'filename="([^"]+)"', caseSensitive: false).firstMatch(disposition);
    return plain?.group(1);
  }
}

String errorText(Object err, [String fallback = 'Something went wrong']) => err is ApiError ? err.message : fallback;
