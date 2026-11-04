import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_lock.dart';
import '../core/session.dart';
import '../core/theme.dart';
import 'art.dart';
import 'phosphor.dart';
import 'ui.dart';

/// Covers the app until the phone's owner unlocks it (see AppLock). Asks
/// once on show; after a cancel or failure it stays here with a button.
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});
  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<AppLock>().unlock();
    });
  }

  @override
  Widget build(BuildContext context) {
    final lock = context.read<AppLock>();
    // BlockSemantics: TalkBack reads only the lock, never what is under it
    // (main.dart also excludes that content). Back is swallowed by AppLock.
    return BlockSemantics(
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: 'TrustVault is locked',
        child: _body(context, lock),
      ),
    );
  }

  Widget _body(BuildContext context, AppLock lock) {
    return Scaffold(
      backgroundColor: C.night,
      body: Stack(
        children: [
          const Positioned.fill(child: NightSky()),
          SafeArea(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 420),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Rise(child: Logo(size: 56)),
                      const SizedBox(height: 18),
                      Rise(
                        delay: 60,
                        child: Semantics(
                          header: true,
                          child: Text('TrustVault is locked', textAlign: TextAlign.center, style: ts(context, size: 22, w: FontWeight.w600, color: Colors.white, spacing: -0.3)),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Rise(
                        delay: 100,
                        child: Text(
                          'Unlock with your face, fingerprint or phone PIN.',
                          textAlign: TextAlign.center,
                          style: ts(context, size: 14, color: Colors.white.withValues(alpha: .75), height: 1.45),
                        ),
                      ),
                      const SizedBox(height: 26),
                      Rise(
                        delay: 140,
                        child: Btn('Unlock', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.fingerprint, onPressed: lock.unlock),
                      ),
                      const SizedBox(height: 10),
                      Rise(
                        delay: 180,
                        child: TextButton.icon(
                          style: TextButton.styleFrom(
                            minimumSize: const Size(kMinTap, kMinTap),
                            foregroundColor: Colors.white.withValues(alpha: .75),
                            overlayColor: Colors.white,
                          ),
                          onPressed: () => context.read<Session>().signOut(),
                          icon: Ic(PhosphorIconsDuotone.signOut, size: 16, color: Colors.white.withValues(alpha: .75)),
                          label: Text('Sign out instead', style: ts(context, size: 13, w: FontWeight.w500, color: Colors.white.withValues(alpha: .75))),
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
