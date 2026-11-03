import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'core/api.dart';
import 'core/app_lock.dart';
import 'core/offline_copies.dart';
import 'core/secure_screen.dart';
import 'core/session.dart';
import 'core/theme.dart';
import 'screens/auth.dart';
import 'screens/shell.dart';
import 'widgets/art.dart';
import 'widgets/lock_screen.dart';
import 'widgets/step_up.dart';

final navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent, systemNavigationBarColor: Colors.transparent));
  final session = Session();
  final theme = ThemeChoice();
  final lock = AppLock()..isSignedIn = () => session.user != null;
  await theme.load();
  // Risky actions refused with step_up_required ask for a fresh factor here.
  Api.I.onStepUp = () async {
    final ctx = navigatorKey.currentContext;
    return ctx != null && ctx.mounted && await askStepUp(ctx);
  };
  // When the session ends (sign-out, expiry, password change) drop any
  // pushed pages so nothing from the old session stays on screen.
  session.addListener(() {
    if (session.user == null || session.mfaPending) navigatorKey.currentState?.popUntil((r) => r.isFirst);
    if (session.user == null) lock.signedOut();
  });
  // Plain copies handed to another app go when the user is back here (THREATS.md V6).
  await OfflineCopies.wipeOpened();
  AppLifecycleListener(onResume: () => OfflineCopies.wipeOpened());
  // Blank the Android Recents / app-switcher thumbnail whenever the app is
  // not in the foreground, so authenticated content (document titles, people's
  // emails, the audit log) is never left in the task switcher, where the app
  // lock (THREATS.md S24) does not reach. FLAG_SECURE elsewhere is scoped to
  // the document screens (V3); this covers every screen while backgrounded.
  BackgroundShield().start();
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: session),
        ChangeNotifierProvider.value(value: theme),
        ChangeNotifierProvider.value(value: lock),
      ],
      child: const TrustVaultApp(),
    ),
  );
  // Lock first (the splash is showing), so no content flashes before it.
  // If nobody turns out to be signed in, the listener above unlocks.
  await lock.start(signedIn: true);
  await session.start();
}

class TrustVaultApp extends StatelessWidget {
  const TrustVaultApp({super.key});
  @override
  Widget build(BuildContext context) {
    final mode = context.watch<ThemeChoice>().mode;
    return MaterialApp(
      title: 'TrustVault',
      debugShowCheckedModeBanner: false,
      navigatorKey: navigatorKey,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: mode == 'light'
          ? ThemeMode.light
          : mode == 'dark'
          ? ThemeMode.dark
          : ThemeMode.system,
      home: const Root(),
      // Above the navigator, so the lock also covers pushed pages and sheets.
      // It covers the app; it does not end or replace the session.
      builder: (context, child) {
        final locked = context.watch<AppLock>().locked && context.watch<Session>().user != null;
        return Stack(children: [?child, if (locked) const Positioned.fill(child: LockScreen())]);
      },
    );
  }
}

class Root extends StatelessWidget {
  const Root({super.key});
  @override
  Widget build(BuildContext context) {
    final s = context.watch<Session>();
    final Widget page;
    if (s.loading) {
      page = const Splash();
    } else if (s.user == null) {
      page = const LoginScreen(key: ValueKey('login'));
    } else if (s.mfaPending) {
      page = const MfaScreen(key: ValueKey('mfa'));
    } else {
      page = HomeShell(key: ValueKey('home-${s.user!.id}'));
    }
    return AnimatedSwitcher(duration: const Duration(milliseconds: 300), child: page);
  }
}

class Splash extends StatelessWidget {
  const Splash({super.key});
  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: C.night,
      body: Stack(
        children: [
          Positioned.fill(child: NightSky()),
          Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [Logo(size: 64), SizedBox(height: 18), Wordmark(light: true)]),
          ),
        ],
      ),
    );
  }
}
