// Pumps the whole app (the same widget tree main() builds) against the fake
// API, and helpers to let real file I/O finish inside widget tests.
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:trustvault/core/session.dart';
import 'package:trustvault/main.dart';

bool _fontsLoaded = false;

/// Loads the app's real fonts so layout in tests matches the phone (the
/// default test font draws every glyph as a wide box and overflows rows).
Future<void> loadAppFonts() async {
  if (_fontsLoaded) return;
  _fontsLoaded = true;
  for (final family in ['Geist', 'GeistMono']) {
    final loader = FontLoader(family);
    for (final f in Directory('assets/fonts').listSync().whereType<File>()) {
      final name = f.uri.pathSegments.last;
      if (name.startsWith('$family-')) loader.addFont(Future.value(ByteData.sublistView(f.readAsBytesSync())));
    }
    await loader.load();
  }
}

Future<Session> pumpApp(WidgetTester tester) async {
  await tester.runAsync(loadAppFonts);
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  final session = Session();
  final theme = ThemeChoice();
  session.addListener(() {
    if (session.user == null || session.mfaPending) navigatorKey.currentState?.popUntil((r) => r.isFirst);
  });
  await tester.pumpWidget(
    MultiProvider(
      providers: [ChangeNotifierProvider.value(value: session), ChangeNotifierProvider.value(value: theme)],
      child: const TrustVaultApp(),
    ),
  );
  await tester.runAsync(session.start);
  await settle(tester);
  return session;
}

/// Lets real async work (files, the fake API) finish and the UI catch up.
/// pumpAndSettle is not used: loading skeletons animate forever.
Future<void> settle(WidgetTester tester, {int rounds = 8}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 15)));
    await tester.pump(const Duration(milliseconds: 120));
  }
}

/// Lets toasts (SnackBars) time out so no timers are left at the end.
Future<void> drainToasts(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}

/// Settles until [done] is true (or gives up after about 10 s of real time).
Future<void> until(WidgetTester tester, bool Function() done) async {
  for (var i = 0; i < 40 && !done(); i++) {
    await settle(tester, rounds: 2);
  }
}
