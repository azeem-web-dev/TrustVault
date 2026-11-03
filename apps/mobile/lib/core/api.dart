import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

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
  /// S19). Not a credential; kept across sign-outs, like a browser cookie.
  static const _deviceCookieName = '__Host-tv_device';
  static const _userAgent = 'TrustVault Android app';

  final _store = const FlutterSecureStorage();
  final _client = http.Client();
  String? _session;
  String? _device;
  String? csrfToken;

  /// Set by the session layer.
  void Function()? onUnauthorized;
  void Function()? onMfaRequired;

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

  Future<dynamic> _finish(http.Response res) async {
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
      if (res.statusCode == 401) onUnauthorized?.call();
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
    final uri = Uri.parse('$base$path');
    final req = http.Request(method, uri)..headers.addAll(_headers(method, json: body != null));
    if (body != null) req.body = jsonEncode(body);
    try {
      final res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 30)));
      return await _finish(res);
    } on SocketException {
      throw ApiError(0, 'Could not reach the server. Check your connection.');
    } on HttpException {
      throw ApiError(0, 'Could not reach the server.');
    } on HandshakeException {
      throw ApiError(0, 'Secure connection failed.');
    }
  }

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body ?? <String, dynamic>{});
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body);
  Future<dynamic> put(String path, Object body) => _send('PUT', path, body);
  Future<dynamic> delete(String path) => _send('DELETE', path);

  /// Multipart upload (new document or new version).
  Future<dynamic> upload(String path, {required List<int> bytes, required String fileName, Map<String, String> fields = const {}}) async {
    final req = http.MultipartRequest('POST', Uri.parse('$base$path'))
      ..headers.addAll(_headers('POST', json: false))
      ..fields.addAll(fields)
      ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: fileName));
    try {
      final res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(minutes: 3)));
      return await _finish(res);
    } on SocketException {
      throw ApiError(0, 'Could not reach the server. Check your connection.');
    }
  }

  /// Fetches a file the API streams as an attachment.
  Future<Download> download(String path, {String fallbackName = 'download'}) async {
    final req = http.Request('GET', Uri.parse('$base$path'))..headers.addAll(_headers('GET', json: false)..remove('Accept'));
    final res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(minutes: 3)));
    if (res.statusCode != 200) {
      await _finish(res);
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
