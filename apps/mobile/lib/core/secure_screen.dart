import 'package:flutter/services.dart';

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
