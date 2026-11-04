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
import 'widgets/phosphor.dart';
import 'widgets/step_up.dart';
import 'widgets/ui.dart';

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
    // Offline at start-up with a stored session: still signed in, so the
    // lock stays on until the server answers and the user unlocks.
    if (session.user == null && !session.offline) lock.signedOut();
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
      // While locked, the content underneath is hidden from TalkBack, takes
      // no touches and cannot hold keyboard focus (AppLock swallows Back).
      // The wrappers are always present so the navigator keeps its state.
      builder: (context, child) {
        final locked = context.watch<AppLock>().locked && context.watch<Session>().user != null;
        return Stack(
          children: [
            ExcludeSemantics(
              excluding: locked,
              child: IgnorePointer(
                ignoring: locked,
                child: Focus(canRequestFocus: false, skipTraversal: true, descendantsAreFocusable: !locked, child: child ?? const SizedBox.shrink()),
              ),
            ),
            if (locked) const Positioned.fill(child: LockScreen()),
          ],
        );
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
    } else if (s.user == null && s.offline) {
      page = const OfflineScreen(key: ValueKey('offline'));
    } else if (s.user == null) {
      page = const LoginScreen(key: ValueKey('login'));
    } else if (s.mfaPending) {
      page = const MfaScreen(key: ValueKey('mfa'));
    } else {
      page = HomeShell(key: ValueKey('home-${s.user!.id}'));
    }
    return AnimatedSwitcher(
      duration: Motion.of(context, Motion.slow),
      switchInCurve: Motion.easeOut,
      switchOutCurve: Motion.easeIn,
      child: page,
    );
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

/// A session is stored but the server could not be reached at start-up.
/// Showing the sign-in form here would read as "you were signed out", so the
/// user gets a Retry instead (and can still choose to sign out).
class OfflineScreen extends StatefulWidget {
  const OfflineScreen({super.key});
  @override
  State<OfflineScreen> createState() => _OfflineScreenState();
}

class _OfflineScreenState extends State<OfflineScreen> {
  bool _busy = false;

  Future<void> _retry() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await context.read<Session>().retry();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = context.watch<Session>();
    return Scaffold(
      backgroundColor: C.night,
      body: Stack(
        children: [
          const Positioned.fill(child: NightSky()),
          SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(28),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Rise(child: Logo(size: 56)),
                      const SizedBox(height: 22),
                      Rise(
                        delay: 60,
                        child: Container(
                          width: 52,
                          height: 52,
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: .06),
                            shape: BoxShape.circle,
                            border: Border.all(color: Colors.white.withValues(alpha: .12)),
                          ),
                          child: const Center(child: Ic(PhosphorIconsDuotone.globe, size: 22, color: C.amber300)),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Rise(
                        delay: 100,
                        child: Semantics(
                          header: true,
                          child: Text(
                            'Can’t reach TrustVault',
                            textAlign: TextAlign.center,
                            style: ts(context, size: 22, w: FontWeight.w600, color: Colors.white, spacing: -0.3),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Rise(
                        delay: 140,
                        child: Semantics(
                          liveRegion: true,
                          child: Text(
                            '${s.offlineMessage ?? 'Check your connection.'} You are still signed in on this phone.',
                            textAlign: TextAlign.center,
                            style: ts(context, size: 14, color: Colors.white.withValues(alpha: .75), height: 1.45),
                          ),
                        ),
                      ),
                      const SizedBox(height: 26),
                      Rise(
                        delay: 180,
                        child: Btn('Try again', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.arrowClockwise, loading: _busy, onPressed: _retry),
                      ),
                      const SizedBox(height: 10),
                      Rise(
                        delay: 220,
                        child: TextButton.icon(
                          style: TextButton.styleFrom(
                            minimumSize: const Size(kMinTap, kMinTap),
                            foregroundColor: Colors.white.withValues(alpha: .75),
                            overlayColor: Colors.white,
                          ),
                          onPressed: _busy ? null : () => context.read<Session>().abandonOffline(),
                          icon: Ic(PhosphorIconsDuotone.signOut, size: 16, color: Colors.white.withValues(alpha: _busy ? .4 : .75)),
                          label: Text('Sign out instead', style: ts(context, size: 13, w: FontWeight.w500, color: Colors.white.withValues(alpha: _busy ? .4 : .75))),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
