import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'core/offline_copies.dart';
import 'core/session.dart';
import 'core/theme.dart';
import 'screens/auth.dart';
import 'screens/shell.dart';
import 'widgets/art.dart';

final navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent, systemNavigationBarColor: Colors.transparent));
  final session = Session();
  final theme = ThemeChoice();
  await theme.load();
  // When the session ends (sign-out, expiry, password change) drop any
  // pushed pages so nothing from the old session stays on screen.
  session.addListener(() {
    if (session.user == null || session.mfaPending) navigatorKey.currentState?.popUntil((r) => r.isFirst);
  });
  // Plain copies handed to another app go when the user is back here (THREATS.md V6).
  await OfflineCopies.wipeOpened();
  AppLifecycleListener(onResume: () => OfflineCopies.wipeOpened());
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: session),
        ChangeNotifierProvider.value(value: theme),
      ],
      child: const TrustVaultApp(),
    ),
  );
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
