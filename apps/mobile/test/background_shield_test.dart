// Regression test for the Android Recents / app-switcher content leak
// (THREATS.md V3 / S24): BackgroundShield must engage FLAG_SECURE whenever the
// app leaves the foreground, so no authenticated screen is left in the task
// switcher thumbnail, and must clear it again on resume without disturbing a
// document screen that is holding FLAG_SECURE in its own right.
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trustvault/core/secure_screen.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('trustvault/secure_screen');
  final calls = <String>[];

  setUp(() {
    SecureScreen.resetForTest();
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('FLAG_SECURE is engaged while backgrounded and cleared on resume', () async {
    final shield = BackgroundShield();
    // Leaving the foreground (inactive fires before the OS captures the
    // Recents snapshot): the screen must be secured.
    shield.didChangeAppLifecycleState(AppLifecycleState.inactive);
    await pumpEventQueue();
    expect(SecureScreen.holders, 1);
    expect(calls, ['on']);

    // Further background states do not double-hold.
    shield.didChangeAppLifecycleState(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(SecureScreen.holders, 1);
    expect(calls, ['on']);

    // Back in the foreground: the flag comes off again.
    shield.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await pumpEventQueue();
    expect(SecureScreen.holders, 0);
    expect(calls, ['on', 'off']);
  });

  test('a document screen already holding FLAG_SECURE keeps it across backgrounding', () async {
    // A document screen is open and holds the flag.
    await SecureScreen.hold();
    expect(calls, ['on']);

    final shield = BackgroundShield();
    shield.didChangeAppLifecycleState(AppLifecycleState.inactive);
    await pumpEventQueue();
    // Still just one 'on': the counted holder means no redundant native call.
    expect(SecureScreen.holders, 2);
    expect(calls, ['on']);

    // On resume the shield releases its hold, but the document's hold remains,
    // so FLAG_SECURE is never turned off while the document is on screen.
    shield.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await pumpEventQueue();
    expect(SecureScreen.holders, 1);
    expect(calls, ['on']);
  });
}
