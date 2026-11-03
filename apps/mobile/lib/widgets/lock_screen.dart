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
    return Scaffold(
      backgroundColor: C.night,
      body: Stack(
        children: [
          const Positioned.fill(child: NightSky()),
          SafeArea(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Logo(size: 56),
                    const SizedBox(height: 18),
                    const Text('TrustVault is locked', style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    Text(
                      'Unlock with your face, fingerprint or phone PIN.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.white.withValues(alpha: .7), fontSize: 14, height: 1.45),
                    ),
                    const SizedBox(height: 26),
                    Btn('Unlock', variant: BtnVariant.primary, size: BtnSize.lg, icon: PhosphorIconsDuotone.fingerprint, onPressed: lock.unlock),
                    const SizedBox(height: 10),
                    TextButton(
                      onPressed: () => context.read<Session>().signOut(),
                      child: Text('Sign out instead', style: TextStyle(color: Colors.white.withValues(alpha: .6), fontSize: 13)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
