import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/app_lock.dart';
import '../core/passkey.dart';
import '../core/format.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/art.dart';
import '../widgets/totp_guide.dart';
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
  List<Map>? _devices;
  List<String>? _policy;
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
      final d = await Api.I.get('/auth/sessions') as Map;
      final isAdmin = mounted && context.read<Session>().user?.isAdmin == true;
      final pol = isAdmin ? await Api.I.get('/admin/settings/mfa-policy') as Map : null;
      if (mounted) {
        setState(() {
          _mfa = r;
          _devices = (d['sessions'] as List).cast<Map>();
          _policy = (pol?['requiredRoles'] as List?)?.cast<String>();
        });
      }
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
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Btn(
                            'Add a passkey on this phone',
                            variant: BtnVariant.primary,
                            icon: PhosphorIconsBold.plus,
                            loading: _busy == 'passkey',
                            onPressed: () => _run('passkey', () async {
                              await Passkeys.register('Android phone');
                              await session.refresh();
                            }, 'Passkey added'),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Uses your screen lock and is saved to your Google account. A passkey made on the website works here too.',
                            style: ts(context, size: 12, color: p.muted, height: 1.45),
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
                      if (!(mfa['requiredByRole'] == true && !hasPasskey))
                        Btn(
                          'Remove',
                          variant: BtnVariant.danger,
                          size: BtnSize.sm,
                          loading: _busy == 'totp-rm',
                          onPressed: () => _run('totp-rm', () => Api.I.delete('/auth/mfa/totp'), 'Authenticator app removed'),
                        ),
                    ],
                  ),
                )
              : _totp != null
              ? _totpSetup(context, p, session)
              : Align(
                  alignment: Alignment.centerLeft,
                  child: Btn(
                    'Set up Google Authenticator',
                    icon: PhosphorIconsDuotone.deviceMobile,
                    loading: _busy == 'totp-setup',
                    onPressed: () => _run('totp-setup', () async {
                      final r = await Api.I.post('/auth/mfa/totp/setup') as Map;
                      setState(() => _totp = (secret: r['secret'] as String, uri: r['otpauthUri'] as String));
                    }, 'Follow the three steps to finish'),
                  ),
                ),
        ),
        gap16,
        _devicesCard(context, p),
        gap16,
        _lockCard(context, p),
        if (user.isAdmin) ...[gap16, _policyCard(context, p)],
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
    return Rise(
      dy: 6,
      child: TotpSetupGuide(
        secret: t.secret,
        uri: t.uri,
        child: Row(
          children: [
            SizedBox(
              width: 150,
              child: TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                autofillHints: const [AutofillHints.oneTimeCode],
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
      ),
    );
  }

  /// Signed-in devices (THREATS.md S22): own sessions only; signing others
  /// out asks for a fresh second factor (the API decides, lib/widgets/step_up.dart asks).
  Widget _devicesCard(BuildContext context, Pal p) {
    final devices = _devices;
    return TvCard(
      title: 'Signed-in devices',
      icon: PhosphorIconsDuotone.desktop,
      description: 'Where your account is signed in now. Sign out anything you don’t recognise.',
      padded: false,
      child: devices == null
          ? const SkeletonRows(rows: 2)
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                RowList(
                  children: [
                    for (final d in devices)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
                        child: Row(
                          children: [
                            IconTile(
                              RegExp('app|Android|iPhone').hasMatch(d['device'] as String) ? PhosphorIconsDuotone.deviceMobile : PhosphorIconsDuotone.desktop,
                              tone: d['current'] == true ? Tone.green : Tone.brand,
                            ),
                            gap12,
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Wrap(
                                    spacing: 6,
                                    crossAxisAlignment: WrapCrossAlignment.center,
                                    children: [
                                      Text(d['device'] as String, style: ts(context, size: 13.5, w: FontWeight.w600)),
                                      if (d['current'] == true) const TvBadge('This device', tone: Tone.green),
                                    ],
                                  ),
                                  Text(
                                    '${d['ip'] ?? 'Unknown IP'} · active ${relativeTime(d['lastSeenAt'] as String?)}${d['authLevel'] != 'mfa' ? ' · password only' : ''}',
                                    style: ts(context, size: 12, color: p.muted),
                                  ),
                                ],
                              ),
                            ),
                            if (d['current'] != true)
                              Btn(
                                'Sign out',
                                size: BtnSize.sm,
                                loading: _busy == 'so-${d['id']}',
                                onPressed: () => _run('so-${d['id']}', () => Api.I.delete('/auth/sessions/${d['id']}'), 'Device signed out'),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
                if (devices.length > 1)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Btn(
                      'Sign out all other devices',
                      variant: BtnVariant.danger,
                      icon: PhosphorIconsDuotone.signOut,
                      loading: _busy == 'others',
                      onPressed: () => _run('others', () => Api.I.post('/auth/sessions/revoke-others'), 'Signed out everywhere else'),
                    ),
                  ),
              ],
            ),
    );
  }

  /// Admin setting: which roles must use a second factor (THREATS.md S20).
  /// The API enforces it, keeps ADMIN on, and asks for a fresh factor.
  Widget _policyCard(BuildContext context, Pal p) {
    final policy = _policy;
    const roles = [('ADMIN', 'Administrators'), ('OWNER', 'Document owners'), ('VIEWER', 'Viewers'), ('EXTERNAL', 'External partners')];
    return TvCard(
      title: 'Second factor required for',
      icon: PhosphorIconsDuotone.shieldCheck,
      description: 'Everyone in these roles must use an authenticator app or a passkey, from their next click. Admins always.',
      padded: false,
      child: policy == null
          ? const SkeletonRows(rows: 3)
          : RowList(
              children: [
                for (final (role, label) in roles)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
                    child: Row(
                      children: [
                        Expanded(child: Text(label, style: ts(context, size: 13.5, w: FontWeight.w600))),
                        if (role == 'ADMIN') const TvBadge('Always', tone: Tone.violet),
                        Switch(
                          value: role == 'ADMIN' || policy.contains(role),
                          onChanged: role == 'ADMIN' || _busy != null
                              ? null
                              : (on) => _run('policy', () async {
                                  final next = on ? [...policy, role] : policy.where((r) => r != role).toList();
                                  final r = await Api.I.put('/admin/settings/mfa-policy', {'requiredRoles': next}) as Map;
                                  setState(() => _policy = (r['requiredRoles'] as List).cast<String>());
                                }, 'Policy saved'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }

  /// Face / fingerprint lock for this phone only (THREATS.md S23).
  Widget _lockCard(BuildContext context, Pal p) {
    final lock = context.watch<AppLock>();
    return TvCard(
      title: 'App lock',
      icon: PhosphorIconsDuotone.lockKey,
      description: 'Ask for your face, fingerprint or phone PIN when TrustVault is opened, or after 30 seconds away.',
      child: Row(
        children: [
          Expanded(
            child: Text(
              lock.supported ? (lock.enabled ? 'On for this phone' : 'Off for this phone') : 'This phone has no screen lock set up',
              style: ts(context, size: 13, color: p.muted),
            ),
          ),
          Switch(value: lock.enabled, onChanged: lock.supported ? (v) => lock.setEnabled(v) : null),
        ],
      ),
    );
  }
}
