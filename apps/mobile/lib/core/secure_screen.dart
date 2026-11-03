import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Android FLAG_SECURE while a document is on screen: screenshots and
/// screen recordings come out black, and the app is blank in Recents
/// (THREATS.md V3). A speed bump: a second camera still works.
///
/// Counted, so the detail screen and the page viewer can both hold it and
/// it only comes off when the last one closes.
class SecureScreen {
  SecureScreen._();
  static const _channel = MethodChannel('trustvault/secure_screen');
  static int _holders = 0;

  static Future<void> hold() async {
    _holders++;
    if (_holders == 1) await _set(true);
  }

  static Future<void> release() async {
    if (_holders == 0) return;
    _holders--;
    if (_holders == 0) await _set(false);
  }

  /// Test seam: clear the counted holders between tests (the counter is static).
  @visibleForTesting
  static void resetForTest() => _holders = 0;

  /// Test seam: how many holders are active right now.
  @visibleForTesting
  static int get holders => _holders;

  static Future<void> _set(bool on) async {
    try {
      await _channel.invokeMethod<void>(on ? 'on' : 'off');
    } on MissingPluginException {
      // Not Android (tests, desktop): nothing to do.
    } on PlatformException {
      // Never block reading because the flag could not be set.
    }
  }
}

/// Holds [SecureScreen] whenever the app leaves the foreground, so the
/// Android Recents / app-switcher thumbnail is blank on every screen, not
/// only the document screens that hold it in the foreground (THREATS.md V3).
///
/// The app lock (S24) only covers the live screen on resume; it does not
/// reach the task-switcher snapshot Android captures when the app is sent to
/// the background. Engaging FLAG_SECURE on `inactive` (fired before the app is
/// actually backgrounded) keeps authenticated content out of that snapshot.
/// It uses [SecureScreen]'s counted holder, so a document screen already
/// holding it stays secure, and a non-document screen returns to normal
/// (screenshot-allowed) once the app is resumed.
class BackgroundShield with WidgetsBindingObserver {
  BackgroundShield();

  bool _shielded = false;

  void start() => WidgetsBinding.instance.addObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (!foreground && !_shielded) {
      _shielded = true;
      SecureScreen.hold();
    } else if (foreground && _shielded) {
      _shielded = false;
      SecureScreen.release();
    }
  }
}
