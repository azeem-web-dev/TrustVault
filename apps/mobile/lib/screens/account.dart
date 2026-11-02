import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/art.dart';
import '../widgets/ui.dart';
import 'shell.dart';

const _roleLabel = {'ADMIN': 'Administrator', 'OWNER': 'Document owner', 'VIEWER': 'Viewer', 'EXTERNAL': 'External partner'};

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key});
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  Map? _mfa;
  String? _error;
  String? _busy;
  ({String secret, String uri})? _totp;
  final _code = TextEditingController();
  final _current = TextEditingController();
  final _next = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
    _next.addListener(() => setState(() {}));
    _code.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _code.dispose();
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/auth/mfa') as Map;
      if (mounted) setState(() => _mfa = r);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _run(String key, Future<void> Function() fn, String success) async {
    setState(() {
      _error = null;
      _busy = key;
    });
    try {
      await fn();
      if (!mounted) return;
      toast(context, success);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final session = context.watch<Session>();
    final user = session.user!;
    final mfa = _mfa;
    final passkeys = (mfa?['passkeys'] as List?)?.cast<Map>() ?? const [];
    final hasPasskey = passkeys.isNotEmpty;
    final checks = [(true, 'Strong password (12+ characters)'), (mfa?['totp'] == true, 'Authenticator app'), (hasPasskey, 'Passkey (phishing-resistant)')];
    final score = checks.where((c) => c.$1).length;
    final nextLen = _next.text.length;

    return PageBody(
      onRefresh: _load,
      children: [
        const PageTitle(title: 'Account & security', icon: PhosphorIconsDuotone.userCircleGear, subtitle: 'Your password and second factors. Every change here is recorded in the audit trail.'),
        Rise(
          child: Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: p.card,
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: p.border),
              boxShadow: p.shadow,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Avatar(user.displayName, size: 64),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(user.displayName, style: ts(context, size: 19, w: FontWeight.w600, spacing: -0.3)),
                          Text(user.email, style: ts(context, size: 13, color: p.muted)),
                          const SizedBox(height: 6),
                          TvBadge(_roleLabel[user.role] ?? user.role, tone: Tone.violet),
                        ],
                      ),
                    ),
                  ],
                ),
                gap16,
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: p.soft,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: p.border),
                  ),
                  child: Row(
                    children: [
                      ScoreRing(value: score, max: 3),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            for (final (done, label) in checks)
                              Padding(
                                padding: const EdgeInsets.symmetric(vertical: 2),
                                child: Row(
                                  children: [
                                    Ic(done ? PhosphorIconsFill.checkCircle : PhosphorIconsRegular.circle, size: 16, color: done ? C.emerald500 : (p.dark ? C.slate600 : C.slate300)),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: Text(label, style: ts(context, size: 12.5, color: done ? null : p.muted)),
                                    ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        if (_error != null) ...[gap16, TvAlert(_error!, onDismiss: () => setState(() => _error = null))],
        gap16,
        TvCard(
          title: 'Passkeys',
          icon: PhosphorIconsDuotone.fingerprint,
          description: "Sign in with your face, fingerprint, PIN or a security key. They can't be phished.",
          actions: mfa == null ? null : TvBadge(hasPasskey ? '${passkeys.length} added' : 'None yet', tone: hasPasskey ? Tone.green : Tone.neutral, dot: true),
          padded: false,
          child: mfa == null
              ? const SkeletonRows(rows: 2)
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (passkeys.isNotEmpty)
                      RowList(
                        children: [
                          for (final k in passkeys)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
                              child: Row(
                                children: [
                                  const IconTile(PhosphorIconsDuotone.key, tone: Tone.violet),
                                  gap12,
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(k['name'] as String, style: ts(context, size: 13.5, w: FontWeight.w600)),
                                        Text('Added ${formatDate(k['createdAt'] as String?)} · last used ${relativeTime(k['lastUsedAt'] as String?)}', style: ts(context, size: 12, color: p.muted)),
                                      ],
                                    ),
                                  ),
                                  Btn(
                                    'Remove',
                                    variant: BtnVariant.danger,
                                    size: BtnSize.sm,
                                    icon: PhosphorIconsDuotone.trash,
                                    loading: _busy == 'rm-${k['id']}',
                                    onPressed: () => _run('rm-${k['id']}', () => Api.I.delete('/auth/mfa/passkeys/${k['id']}'), 'Passkey removed'),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: p.soft,
                        border: Border(top: BorderSide(color: p.divider)),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Ic(PhosphorIconsDuotone.globe, size: 18, color: p.muted),
                          gap8,
                          Expanded(
                            child: Text(
                              'To add a passkey, open vault.rayyanazeem.cloud in your browser, go to Account, and choose “Add passkey”. Passkeys are tied to the website address.',
                              style: ts(context, size: 12.5, color: p.muted, height: 1.5),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
        ),
        gap16,
        TvCard(
          title: 'Authenticator app',
          icon: PhosphorIconsDuotone.deviceMobile,
          description: 'A 6-digit code that changes every 30 seconds.',
          actions: mfa == null ? null : TvBadge(mfa['totp'] == true ? 'On' : 'Off', tone: mfa['totp'] == true ? Tone.green : Tone.neutral, dot: true),
          child: mfa == null
              ? const Skeleton(height: 40)
              : mfa['totp'] == true
              ? Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(color: p.dark ? C.emerald500.withValues(alpha: .1) : C.emerald50.withValues(alpha: .6), borderRadius: BorderRadius.circular(14)),
                  child: Row(
                    children: [
                      Ic(PhosphorIconsDuotone.shieldCheck, size: 22, color: p.dark ? C.emerald300 : C.emerald600),
                      gap12,
                      Expanded(child: Text('Set up. You will be asked for a code when you sign in.', style: ts(context, size: 13.5))),
                    ],
                  ),
                )
              : _totp != null
              ? _totpSetup(context, p, session)
              : Align(
                  alignment: Alignment.centerLeft,
                  child: Btn(
                    'Set up an authenticator app',
                    icon: PhosphorIconsDuotone.deviceMobile,
                    loading: _busy == 'totp-setup',
                    onPressed: () => _run('totp-setup', () async {
                      final r = await Api.I.post('/auth/mfa/totp/setup') as Map;
                      setState(() => _totp = (secret: r['secret'] as String, uri: r['otpauthUri'] as String));
                    }, 'Scan the code, then enter the 6 digits'),
                  ),
                ),
        ),
        gap16,
        TvCard(
          title: 'Password',
          icon: PhosphorIconsDuotone.password,
          description: 'Changing it signs you out on every device.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FieldLabel(
                'Current password',
                child: TextField(
                  controller: _current,
                  obscureText: true,
                  autofillHints: const [AutofillHints.password],
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.lockSimple),
                ),
              ),
              gap16,
              FieldLabel(
                'New password',
                hint: 'At least 12 characters. Length matters more than symbols.',
                child: TextField(
                  controller: _next,
                  obscureText: true,
                  autofillHints: const [AutofillHints.newPassword],
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.lockSimple),
                ),
              ),
              if (nextLen > 0) ...[
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(9),
                  child: LinearProgressIndicator(
                    value: (nextLen / 20).clamp(0, 1).toDouble(),
                    minHeight: 6,
                    backgroundColor: p.soft2,
                    color: nextLen < 12
                        ? C.red500
                        : nextLen < 16
                        ? C.amber500
                        : C.emerald500,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  nextLen < 12
                      ? '${12 - nextLen} more characters needed'
                      : nextLen < 16
                      ? 'Good. Longer is even better.'
                      : 'Strong',
                  style: ts(context, size: 12, color: p.muted),
                ),
              ],
              gap16,
              Btn(
                'Change password',
                variant: BtnVariant.primary,
                expand: true,
                loading: _busy == 'pw',
                onPressed: _current.text.isEmpty && nextLen == 0
                    ? null
                    : () => _run('pw', () async {
                        await Api.I.post('/auth/password', {'currentPassword': _current.text, 'newPassword': _next.text});
                        await session.endedElsewhere();
                      }, 'Password changed. You have been signed out everywhere.'),
              ),
            ],
          ),
        ),
        gap16,
        TvCard(
          title: 'Appearance',
          icon: PhosphorIconsDuotone.palette,
          child: Row(
            children: [
              Expanded(
                child: Text('Light, dark, or match your phone.', style: ts(context, size: 13, color: p.muted)),
              ),
              const ThemeSwitch(),
            ],
          ),
        ),
        gap16,
        Btn('Sign out', variant: BtnVariant.secondary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.signOut, onPressed: session.signOut),
        gap16,
        Center(
          child: Text('TrustVault for Android · signed in to vault.rayyanazeem.cloud', style: ts(context, size: 11.5, color: p.faint)),
        ),
      ],
    );
  }

  Widget _totpSetup(BuildContext context, Pal p, Session session) {
    final t = _totp!;
    Widget step(int n, Widget child) => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: const BoxDecoration(shape: BoxShape.circle, gradient: C.brandGradient),
            child: Center(
              child: Text(
                '$n',
                style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
              ),
            ),
          ),
          gap12,
          Expanded(
            child: Padding(padding: const EdgeInsets.only(top: 2), child: child),
          ),
        ],
      ),
    );
    return Rise(
      dy: 6,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: C.slate200),
              ),
              child: QrImageView(
                data: t.uri,
                size: 168,
                padding: EdgeInsets.zero,
                eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: C.slate900),
                dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: C.slate900),
              ),
            ),
          ),
          gap16,
          step(1, Text('Open Google Authenticator, 1Password or Authy and scan the code.', style: ts(context, size: 13.5, color: p.body))),
          step(
            2,
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Or enter this key:', style: ts(context, size: 13.5, color: p.body)),
                const SizedBox(height: 4),
                Container(
                  padding: const EdgeInsets.fromLTRB(10, 2, 2, 2),
                  decoration: BoxDecoration(color: p.soft2, borderRadius: BorderRadius.circular(10)),
                  child: Row(
                    children: [
                      Expanded(child: Mono(t.secret, size: 12)),
                      CopyBtn(t.secret, label: 'Copy key'),
                    ],
                  ),
                ),
              ],
            ),
          ),
          step(3, Text('Type the 6 digits the app shows.', style: ts(context, size: 13.5, color: p.body))),
          Row(
            children: [
              SizedBox(
                width: 150,
                child: TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  textAlign: TextAlign.center,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  style: const TextStyle(fontFamily: C.mono, fontSize: 18, letterSpacing: 6),
                  decoration: fieldDeco(hint: '000000').copyWith(counterText: ''),
                ),
              ),
              gap8,
              Btn(
                'Turn on',
                variant: BtnVariant.primary,
                loading: _busy == 'totp',
                onPressed: _code.text.length != 6
                    ? null
                    : () => _run('totp', () async {
                        await Api.I.post('/auth/mfa/totp/enable', {'code': _code.text});
                        setState(() {
                          _totp = null;
                          _code.clear();
                        });
                        await session.refresh();
                      }, 'Authenticator app turned on'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
