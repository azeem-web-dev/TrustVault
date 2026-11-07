import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'offline_copies.dart';
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
      if (user != null || mfaPending) {
        endedNotice = sessionEndedText;
        _reset();
      }
    };
    Api.I.onMfaRequired = () {
      if (!mfaPending) {
        mfaPending = true;
        notifyListeners();
      }
    };
  }

  /// Shown on the sign-in screen after the server said the session is over.
  static const sessionEndedText = 'Your session ended, please sign in again.';
  String? endedNotice;

  User? user;
  bool loading = true;
  bool mfaPending = false;
  bool mfaEnrolled = false;

  /// A session is stored on the phone but the server could not be reached
  /// (offline, timeout) when the app started. Root shows a Retry screen
  /// instead of the sign-in form, which would wrongly suggest a sign-out.
  bool offline = false;

  /// Why the start-up check failed, for the Retry screen.
  String? offlineMessage;

  Future<void> start() async {
    try {
      await Api.I.init();
      if (Api.I.hasSession) {
        await refresh();
      }
    } catch (_) {
      // Never leave the app on the splash screen: fall through to Login.
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Retry from the "Can't reach TrustVault" screen.
  Future<void> retry() async {
    if (!Api.I.hasSession) {
      offline = false;
      notifyListeners();
      return;
    }
    await refresh();
  }

  /// Leave the offline screen for the sign-in form (the stored session is
  /// dropped and the phone wiped, exactly like a sign-out).
  Future<void> abandonOffline() async {
    await _reset();
  }

  Future<void> refresh() async {
    try {
      final r = await Api.I.get('/auth/me') as Map;
      user = User.fromJson(r['user'] as Map);
      mfaPending = r['mfaRequired'] == true && r['mfaSatisfied'] != true;
      mfaEnrolled = r['mfaEnrolled'] == true;
      offline = false;
      offlineMessage = null;
    } on ApiError catch (e) {
      if (e.status == 401) {
        if (user != null) endedNotice = sessionEndedText;
        user = null;
        mfaPending = false;
        offline = false;
        await Api.I.clearSession();
      } else if (e.status == 0 && user == null && Api.I.hasSession) {
        offline = true;
        offlineMessage = e.message;
      }
    } catch (_) {
      // An unexpected body: keep whatever state we had.
    }
    notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    endedNotice = null;
    final r = await Api.I.post('/auth/login', {'email': email, 'password': password}) as Map;
    // The account has had many failed sign-ins and this phone is new to it:
    // the person finishes from the emailed link instead (THREATS.md S27).
    if (r['signInLinkSent'] == true) throw ApiError(202, r['message'] is String ? r['message'] as String : 'Check your email to finish signing in.');
    user = User.fromJson(r['user'] as Map);
    offline = false;
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
    // Downloaded copies (encrypted, one folder per document) and the
    // temporary files of uploads leave with the session, and so does any
    // plain copy opened from them.
    await LocalCopies.wipeAll();
    await OfflineCopies.wipeOpened();
    user = null;
    mfaPending = false;
    offline = false;
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
