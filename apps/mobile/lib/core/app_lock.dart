import 'package:flutter/material.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Face / fingerprint lock for the app (THREATS.md S24).
///
/// When the app is opened, or comes back after [grace] in the background,
/// the screen is covered until the phone's owner unlocks it with a
/// biometric or, failing that, the device PIN, pattern or password. It is a
/// local screen lock only: it never replaces the server's session, password
/// or second factor, and a failed or cancelled unlock simply stays locked.
class AppLock extends ChangeNotifier with WidgetsBindingObserver {
  AppLock();

  static const grace = Duration(seconds: 30);
  static const _prefKey = 'tv-app-lock';

  /// Set by main.dart: there is only something to lock while signed in.
  bool Function() isSignedIn = () => false;

  final _auth = LocalAuthentication();
  bool supported = false;
  bool enabled = false;
  bool locked = false;
  bool _busy = false;
  DateTime? _leftAt;

  /// Reads the setting (default on when the phone can do it) and locks if on.
  Future<void> start({required bool signedIn}) async {
    try {
      supported = await _auth.isDeviceSupported();
    } catch (_) {
      supported = false;
    }
    bool? saved;
    try {
      saved = (await SharedPreferences.getInstance()).getBool(_prefKey);
    } catch (_) {}
    enabled = supported && (saved ?? true);
    locked = enabled && signedIn;
    WidgetsBinding.instance.addObserver(this);
    notifyListeners();
  }

  Future<void> setEnabled(bool value) async {
    // Turning it off is itself guarded: prove you are the phone's owner first.
    if (!value && enabled && !await _authenticate('Confirm to turn off the app lock')) return;
    enabled = value && supported;
    try {
      (await SharedPreferences.getInstance()).setBool(_prefKey, enabled);
    } catch (_) {}
    notifyListeners();
  }

  /// Nothing to protect while signed out; the next sign-in starts unlocked.
  void signedOut() {
    locked = false;
    notifyListeners();
  }

  Future<void> unlock() async {
    if (await _authenticate('Unlock TrustVault')) {
      locked = false;
      notifyListeners();
    }
  }

  Future<bool> _authenticate(String reason) async {
    if (_busy) return false;
    _busy = true;
    try {
      // biometricOnly false: the system falls back to the device PIN.
      return await _auth.authenticate(localizedReason: reason, biometricOnly: false, persistAcrossBackgrounding: true);
    } catch (_) {
      return false;
    } finally {
      _busy = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!enabled) return;
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      // The biometric prompt itself backgrounds the app briefly; ignore that.
      if (!_busy) _leftAt ??= DateTime.now();
    } else if (state == AppLifecycleState.resumed) {
      final left = _leftAt;
      _leftAt = null;
      if (left != null && DateTime.now().difference(left) >= grace && !locked && isSignedIn()) {
        locked = true;
        notifyListeners();
      }
    }
  }
}
