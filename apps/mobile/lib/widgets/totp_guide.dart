import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/theme.dart';
import 'phosphor.dart';
import 'ui.dart';

const _playStore = 'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2';

/// "ABCD EFGH ..." — easier to type into an authenticator app by hand.
String groupKey(String secret) => secret.replaceAllMapped(RegExp(r'.{4}'), (m) => '${m[0]} ').trim();

/// The three steps to set up Google Authenticator (or any TOTP app), the
/// same as the website. The code typed in step 3 ([child]) is checked by the
/// API, which computes what the app computes (RFC 6238, SHA-1, 6 digits, 30 s).
class TotpSetupGuide extends StatelessWidget {
  const TotpSetupGuide({super.key, required this.secret, required this.uri, required this.child});
  final String secret;
  final String uri;
  final Widget child;

  Future<void> _open(BuildContext context, String url, String fallback) async {
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication).catchError((_) => false);
    if (!ok && context.mounted) toast(context, fallback, tone: Tone.amber);
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final body = ts(context, size: 13.5, color: p.body, height: 1.45);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Step(
          n: 1,
          title: 'Install Google Authenticator',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Free on Google Play. Microsoft Authenticator, 1Password or Authy work too.', style: body),
              const SizedBox(height: 8),
              Btn('Get it on Google Play', size: BtnSize.sm, icon: PhosphorIconsDuotone.arrowSquareOut, onPressed: () => _open(context, _playStore, 'Could not open the Play Store')),
            ],
          ),
        ),
        _Step(
          n: 2,
          title: 'Add TrustVault to the app',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('On this phone, tap below and the app adds it for you.', style: body),
              const SizedBox(height: 8),
              Btn(
                'Open in authenticator app',
                size: BtnSize.sm,
                variant: BtnVariant.primary,
                icon: PhosphorIconsDuotone.deviceMobile,
                onPressed: () => _open(context, uri, 'No authenticator app found. Install one first (step 1), or copy the key.'),
              ),
              const SizedBox(height: 12),
              Text('Or choose “Enter a setup key” in the app and paste this key (time based):', style: ts(context, size: 12.5, color: p.muted, height: 1.45)),
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
                decoration: BoxDecoration(color: p.soft2, borderRadius: BorderRadius.circular(10)),
                child: Row(
                  children: [
                    Expanded(child: Mono(groupKey(secret), size: 13)),
                    CopyBtn(secret, label: 'Copy key'),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Text('Setting up on another phone? Scan this code with it:', style: ts(context, size: 12.5, color: p.muted)),
              const SizedBox(height: 8),
              Center(
                child: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16), border: Border.all(color: C.slate200)),
                  child: QrImageView(
                    data: uri,
                    size: 150,
                    padding: EdgeInsets.zero,
                    eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: C.slate900),
                    dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: C.slate900),
                  ),
                ),
              ),
            ],
          ),
        ),
        _Step(
          n: 3,
          title: 'Type the 6-digit code it shows',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('The code changes every 30 seconds; use the newest one.', style: body),
              const SizedBox(height: 8),
              child,
            ],
          ),
        ),
      ],
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.title, required this.child});
  final int n;
  final String title;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: const BoxDecoration(shape: BoxShape.circle, gradient: C.brandGradient),
            child: Center(child: Text('$n', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600))),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(title, style: ts(context, size: 14, w: FontWeight.w600)),
                const SizedBox(height: 4),
                child,
              ],
            ),
          ),
        ],
      ),
    );
  }
}
