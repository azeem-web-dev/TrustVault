import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'local_copies.dart';

class User {
  User(this.id, this.email, this.displayName, this.role);
  factory User.fromJson(Map j) => User(j['id'] as String, j['email'] as String, j['displayName'] as String, j['role'] as String);
  final String id;
  final String email;
  final String displayName;
  final String role; // ADMIN | OWNER | VIEWER | EXTERNAL
  bool get isAdmin => role == 'ADMIN';
  bool get isOwner => role == 'OWNER';
  String get firstName => displayName.split(' ').first;
}

/// Knows who is signed in, for display only. Hiding something here is a
/// convenience: every request is still checked by the API.
class Session extends ChangeNotifier {
  Session() {
    Api.I.onUnauthorized = () {
      if (user != null || mfaPending) _reset();
    };
    Api.I.onMfaRequired = () {
      if (!mfaPending) {
        mfaPending = true;
        notifyListeners();
      }
    };
  }

  User? user;
  bool loading = true;
  bool mfaPending = false;
  bool mfaEnrolled = false;

  Future<void> start() async {
    await Api.I.init();
    if (Api.I.hasSession) {
      await refresh();
    }
    loading = false;
    notifyListeners();
  }

  Future<void> refresh() async {
    try {
      final r = await Api.I.get('/auth/me') as Map;
      user = User.fromJson(r['user'] as Map);
      mfaPending = r['mfaRequired'] == true && r['mfaSatisfied'] != true;
      mfaEnrolled = r['mfaEnrolled'] == true;
    } on ApiError catch (e) {
      if (e.status == 401) {
        user = null;
        mfaPending = false;
        await Api.I.clearSession();
      }
    }
    notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    final r = await Api.I.post('/auth/login', {'email': email, 'password': password}) as Map;
    user = User.fromJson(r['user'] as Map);
    mfaPending = r['mfaRequired'] == true;
    mfaEnrolled = r['mfaEnrolled'] == true;
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await Api.I.post('/auth/logout');
    } catch (_) {}
    await _reset();
  }

  Future<void> _reset() async {
    await Api.I.clearSession();
    // Downloaded copies are decrypted files: they leave with the session.
    await LocalCopies.wipeAll();
    user = null;
    mfaPending = false;
    notifyListeners();
  }

  /// After the password is changed the API ends every session.
  Future<void> endedElsewhere() => _reset();
}

/// Light / dark / system, remembered on the device.
class ThemeChoice extends ChangeNotifier {
  String mode = 'system';
  Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      mode = p.getString('tv-theme') ?? 'system';
    } catch (_) {}
    notifyListeners();
  }

  Future<void> set(String m) async {
    mode = m;
    notifyListeners();
    try {
      (await SharedPreferences.getInstance()).setString('tv-theme', m);
    } catch (_) {}
  }
}
