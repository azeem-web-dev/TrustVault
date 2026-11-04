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

/// Cross-fades a card body from skeleton to content (§2.3); instant under
/// reduced motion.
Widget _swap(BuildContext context, Object state, Widget child) => AnimatedSwitcher(
  duration: Motion.of(context),
  switchInCurve: Motion.curve,
  switchOutCurve: Motion.easeIn,
  layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
  child: KeyedSubtree(key: ValueKey(state), child: child),
);

/// Opens or closes an inline panel by animating its height.
Widget _reveal(BuildContext context, Widget? child) => AnimatedSize(
  duration: Motion.of(context),
  curve: Motion.curve,
  alignment: Alignment.topCenter,
  child: child ?? const SizedBox(width: double.infinity),
);

/// Link-style text button with a 44px tap target.
ButtonStyle _link(Color color) => TextButton.styleFrom(foregroundColor: color, minimumSize: const Size(kMinTap, kMinTap), padding: const EdgeInsets.symmetric(horizontal: 10));

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key});
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  Map? _mfa;
  List<Map>? _devices;
  List<String>? _policy;
  /// Error from the last load (R5); errors from actions are per card in [_errors].
  String? _loadError;
  final Map<String, String> _errors = {};
  String? _busy;
  int _gen = 0;
  ({String secret, String uri})? _totp;
  // Turning email codes on (THREATS.md S30): where the code was sent, and what
  // was typed. Null until the user asks for a code.
  String? _emailSetup;
  final _code = TextEditingController();
  final _emailCode = TextEditingController();
  final _current = TextEditingController();
  final _next = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
    _current.addListener(() => setState(() {}));
    _next.addListener(() => setState(() {}));
    _code.addListener(() => setState(() {}));
    _emailCode.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _code.dispose();
    _emailCode.dispose();
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    // Signed out (e.g. after a password change): nothing to load.
    if (context.read<Session>().user == null) return;
    try {
      final isAdmin = context.read<Session>().user?.isAdmin == true;
      final res = await Future.wait([
        Api.I.get('/auth/mfa'),
        Api.I.get('/auth/sessions'),
        if (isAdmin) Api.I.get('/admin/settings/mfa-policy'),
      ]);
      if (mounted && gen == _gen) {
        setState(() {
          _mfa = res[0] as Map;
          _devices = ((res[1] as Map)['sessions'] as List).cast<Map>();
          _policy = isAdmin ? ((res[2] as Map)['requiredRoles'] as List?)?.cast<String>() : null;
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen && context.read<Session>().user != null) setState(() => _loadError = errorText(e));
    }
  }

  /// The card an action belongs to, so its error shows inside that card
  /// rather than at the top of a long page (R6).
  static String _cardOf(String key) {
    if (key == 'passkey' || key.startsWith('rm-')) return 'passkeys';
    if (key.startsWith('totp')) return 'totp';
    if (key.startsWith('email')) return 'email';
    if (key == 'others' || key.startsWith('so-')) return 'devices';
    return key; // 'policy', 'pw'
  }

  /// Runs one action at a time. [reload] is false when the action ends the
  /// session (password change), so nothing is fetched on a dead session.
  Future<void> _run(String key, Future<void> Function() fn, String success, {bool reload = true}) async {
    if (_busy != null) return;
    final card = _cardOf(key);
    setState(() {
      _errors.remove(card);
      _busy = key;
    });
    try {
      await fn();
      if (!mounted) return;
      toast(context, success);
      if (reload && context.read<Session>().user != null) await _load();
    } catch (e) {
      if (mounted) setState(() => _errors[card] = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// The error of [card], if its last action failed.
  Widget _cardError(String card, {EdgeInsets padding = EdgeInsets.zero}) {
    final e = _errors[card];
    if (e == null) return const SizedBox.shrink();
    return Padding(
      padding: padding,
      child: Rise(dy: 6, child: TvAlert(e, onDismiss: () => setState(() => _errors.remove(card)))),
    );
  }

  /// Placeholder while a card's data is missing: a skeleton while loading,
  /// a short note once the load has failed (the retry is at the top).
  Widget _pending(Widget skeleton) => _loadError == null
      ? skeleton
      : Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Ic(PhosphorIconsDuotone.warning, size: 16, color: Pal.of(context).warning),
              gap8,
              Text('Not loaded. Pull down to try again.', style: ts(context, size: 13, color: Pal.of(context).muted)),
            ],
          ),
        );

  Future<void> _changePassword(Session session) async {
    final ok = await showConfirm(
      context,
      'Change your password?',
      'You will be signed out on every device, including this one, and must sign in again with the new password.',
      confirmLabel: 'Change password',
      icon: PhosphorIconsDuotone.password,
    );
    if (!ok || !mounted) return;
    await _run('pw', () async {
      await Api.I.post('/auth/password', {'currentPassword': _current.text, 'newPassword': _next.text});
      await session.endedElsewhere();
    }, 'Password changed. You have been signed out everywhere.', reload: false);
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final session = context.watch<Session>();
    final user = session.user;
    // Signed out: this page is fading out; draw nothing from the old session.
    if (user == null) return const SizedBox.shrink();
    final mfa = _mfa;
    final passkeys = (mfa?['passkeys'] as List?)?.cast<Map>() ?? const [];
    final hasPasskey = passkeys.isNotEmpty;
    final checks = [(true, 'Strong password (12+ characters)'), (mfa?['totp'] == true, 'Authenticator app'), (hasPasskey, 'Passkey (phishing-resistant)')];
    final score = checks.where((c) => c.$1).length;
    final nextLen = _next.text.length;
    // Email codes (THREATS.md S30): a non-admin can turn them on/off. Admins and
    // demo accounts are refused by the API, reported via `emailUnavailable`.
    final emailOn = mfa?['email'] == true;
    final emailTo = (mfa?['emailTo'] as String?) ?? 'your email';
    final emailUnavailable = mfa?['emailUnavailable'] as String?;
    final factorCount = ((mfa?['totp'] == true) ? 1 : 0) + passkeys.length + (emailOn ? 1 : 0);
    // Your role must keep a factor, and email codes are the only one left.
    final lastRequired = (mfa?['requiredByRole'] == true) && factorCount <= 1;

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
                                    AnimatedSwitcher(
                                      duration: Motion.of(context),
                                      transitionBuilder: (c, a) => ScaleTransition(scale: a, child: FadeTransition(opacity: a, child: c)),
                                      child: Ic(
                                        done ? PhosphorIconsFill.checkCircle : PhosphorIconsRegular.circle,
                                        key: ValueKey(done),
                                        size: 16,
                                        color: done ? p.success : p.lineStrong,
                                      ),
                                    ),
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
        if (_loadError != null) ...[
          gap16,
          ErrorState(
            compact: true,
            title: mfa == null ? 'Could not load your security settings' : 'Could not refresh',
            message: _loadError,
            onRetry: _load,
          ),
        ],
        gap16,
        TvCard(
          title: 'Passkeys',
          icon: PhosphorIconsDuotone.fingerprint,
          description: "Sign in with your face, fingerprint, PIN or a security key. They can't be phished.",
          actions: mfa == null ? null : TvBadge(hasPasskey ? '${passkeys.length} added' : 'None yet', tone: hasPasskey ? Tone.green : Tone.neutral, dot: true),
          padded: false,
          child: _swap(context, mfa == null ? 'pending' : 'ready', mfa == null
              ? _pending(const SkeletonRows(rows: 2))
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _cardError('passkeys', padding: const EdgeInsets.fromLTRB(16, 0, 16, 12)),
                    if (passkeys.isNotEmpty)
                      RowList(
                        children: [
                          for (var i = 0; i < passkeys.length; i++)
                            Rise(
                              key: ValueKey(passkeys[i]['id']),
                              delay: (i < 8 ? i : 8) * 40,
                              child: Builder(builder: (context) {
                                final k = passkeys[i];
                                return Padding(
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
                                    // Your role must keep one second factor (R6).
                                    onPressed: lastRequired || _busy != null
                                        ? null
                                        : () => _run('rm-${k['id']}', () => Api.I.delete('/auth/mfa/passkeys/${k['id']}'), 'Passkey removed'),
                                  ),
                                ],
                              ),
                            );
                              }),
                            ),
                        ],
                      ),
                    if (passkeys.isNotEmpty && lastRequired)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                        child: Text('Your role must keep two-step verification. Add another passkey or an authenticator app before removing this one.',
                            style: ts(context, size: 12, color: p.muted, height: 1.45)),
                      ),
                    if (passkeys.isEmpty)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                        child: Row(
                          children: [
                            const IconTile(PhosphorIconsDuotone.fingerprint, tone: Tone.violet, size: 36),
                            gap12,
                            Expanded(child: Text('No passkeys yet. Add one to sign in without a code.', style: ts(context, size: 13, color: p.muted, height: 1.45))),
                          ],
                        ),
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
                            onPressed: _busy != null ? null : () => _run('passkey', () async {
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
                )),
        ),
        gap16,
        TvCard(
          title: 'Authenticator app',
          icon: PhosphorIconsDuotone.deviceMobile,
          description: 'A 6-digit code that changes every 30 seconds.',
          actions: mfa == null ? null : TvBadge(mfa['totp'] == true ? 'On' : 'Off', tone: mfa['totp'] == true ? Tone.green : Tone.neutral, dot: true),
          child: _swap(context, mfa == null ? 'pending' : 'ready', mfa == null
              ? _pending(const Skeleton(height: 40))
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _cardError('totp', padding: const EdgeInsets.only(bottom: 12)),
                    _swap(context, mfa['totp'] == true ? 'on' : (_totp != null ? 'setup' : 'off'), mfa['totp'] == true
              ? Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: toneOf(Tone.green, p.dark).bg,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: toneOf(Tone.green, p.dark).ring),
                  ),
                  child: Row(
                    children: [
                      Ic(PhosphorIconsDuotone.shieldCheck, size: 22, color: p.success),
                      gap12,
                      Expanded(child: Text('Set up. You will be asked for a code when you sign in.', style: ts(context, size: 13.5))),
                      // Same last-factor rule as passkeys and email codes (R6).
                      if (!lastRequired)
                        Btn(
                          'Remove',
                          variant: BtnVariant.danger,
                          size: BtnSize.sm,
                          icon: PhosphorIconsDuotone.trash,
                          loading: _busy == 'totp-rm',
                          onPressed: _busy != null ? null : () => _run('totp-rm', () => Api.I.delete('/auth/mfa/totp'), 'Authenticator app removed'),
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
                    onPressed: _busy != null ? null : () => _run('totp-setup', () async {
                      final r = await Api.I.post('/auth/mfa/totp/setup') as Map;
                      if (mounted) setState(() => _totp = (secret: r['secret'] as String, uri: r['otpauthUri'] as String));
                    }, 'Follow the three steps to finish'),
                  ),
                )),
                    if (mfa['totp'] == true && lastRequired) ...[
                      gap8,
                      Text('Your role must keep two-step verification. Add a passkey or email codes before removing the authenticator app.',
                          style: ts(context, size: 12, color: p.muted, height: 1.45)),
                    ],
                  ],
                )),
        ),
        gap16,
        TvCard(
          title: 'Email code',
          icon: PhosphorIconsDuotone.envelope,
          description: 'A 6-digit code emailed to you each time you sign in. Easy, but weaker: anyone who can read your email can use it.',
          actions: mfa == null ? null : TvBadge(emailOn ? 'On' : 'Off', tone: emailOn ? Tone.green : Tone.neutral, dot: true),
          child: _swap(context, mfa == null ? 'pending' : 'ready', mfa == null
              ? _pending(const Skeleton(height: 40))
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _cardError('email', padding: const EdgeInsets.only(bottom: 12)),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            emailUnavailable ?? (emailOn ? 'On. A code is emailed to $emailTo when you sign in.' : 'Off. Turn it on to get a code at $emailTo.'),
                            style: ts(context, size: 13, color: p.muted, height: 1.4),
                          ),
                        ),
                        gap12,
                        Switch(
                          value: emailOn,
                          onChanged: (emailUnavailable != null && !emailOn) || (emailOn && lastRequired) || _busy != null || _emailSetup != null
                              ? null
                              : (on) {
                                  if (on) {
                                    _run('email-send', () async {
                                      final r = await Api.I.post('/auth/mfa/email/send', {'purpose': 'enable'}) as Map;
                                      if (mounted) {
                                        setState(() {
                                          _emailCode.clear();
                                          _emailSetup = r['sentTo'] as String;
                                        });
                                      }
                                    }, 'Code sent. Check your email.');
                                  } else {
                                    // Turning off is a step-up route: the API asks for a fresh factor first.
                                    _run('email-off', () => Api.I.delete('/auth/mfa/email'), 'Email codes turned off');
                                  }
                                },
                        ),
                      ],
                    ),
                    if (emailOn && lastRequired) ...[
                      gap8,
                      Text('Your role must keep two-step verification. Add an authenticator app or passkey before turning email codes off.', style: ts(context, size: 12, color: p.muted, height: 1.45)),
                    ],
                    _reveal(context, _emailSetup == null ? null : Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(14), border: Border.all(color: p.line)),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Padding(padding: const EdgeInsets.only(top: 1), child: Ic(PhosphorIconsDuotone.envelope, size: 16, color: p.accent)),
                                gap8,
                                Expanded(child: Text('We emailed a 6-digit code to $_emailSetup. Enter it to turn email codes on.', style: ts(context, size: 13, height: 1.4))),
                              ],
                            ),
                            gap12,
                            Row(
                              children: [
                                Expanded(
                                  child: TextField(
                                    controller: _emailCode,
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
                                  loading: _busy == 'email-on',
                                  onPressed: _emailCode.text.length != 6 || _busy != null
                                      ? null
                                      : () => _run('email-on', () async {
                                          await Api.I.post('/auth/mfa/email/enable', {'code': _emailCode.text});
                                          if (mounted) {
                                            setState(() {
                                              _emailSetup = null;
                                              _emailCode.clear();
                                            });
                                          }
                                          await session.refresh();
                                        }, 'Email codes turned on'),
                                ),
                              ],
                            ),
                            gap8,
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Wrap(
                                children: [
                                  TextButton(
                                    style: _link(p.accent),
                                    onPressed: _busy != null
                                        ? null
                                        : () => _run('email-send', () async {
                                            final r = await Api.I.post('/auth/mfa/email/send', {'purpose': 'enable'}) as Map;
                                            if (mounted) {
                                              setState(() {
                                                _emailCode.clear();
                                                _emailSetup = r['sentTo'] as String;
                                              });
                                            }
                                          }, 'Code sent. Check your email.'),
                                    child: Text('No email? Send a new code', style: ts(context, size: 13, w: FontWeight.w500, color: p.accent)),
                                  ),
                                  TextButton(
                                    style: _link(p.muted),
                                    onPressed: _busy != null ? null : () => setState(() {
                                      _emailSetup = null;
                                      _emailCode.clear();
                                    }),
                                    child: Text('Cancel', style: ts(context, size: 13, color: p.muted)),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    )),
                  ],
                )),
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
              _cardError('pw', padding: const EdgeInsets.only(bottom: 16)),
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
              _reveal(
                context,
                nextLen == 0
                    ? null
                    : Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Builder(builder: (context) {
                          final strength = nextLen < 12 ? p.danger : (nextLen < 16 ? p.warning : p.success);
                          return Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              ClipRRect(
                                borderRadius: BorderRadius.circular(9),
                                child: TweenAnimationBuilder<double>(
                                  tween: Tween(end: (nextLen / 20).clamp(0, 1).toDouble()),
                                  duration: Motion.of(context),
                                  curve: Motion.curve,
                                  builder: (_, v, _) => LinearProgressIndicator(value: v, minHeight: 6, backgroundColor: p.soft2, color: strength),
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                nextLen < 12
                                    ? '${12 - nextLen} more characters needed'
                                    : nextLen < 16
                                    ? 'Good. Longer is even better.'
                                    : 'Strong',
                                style: ts(context, size: 12, w: FontWeight.w500, color: strength),
                              ),
                            ],
                          );
                        }),
                      ),
              ),
              gap16,
              Btn(
                'Change password',
                variant: BtnVariant.primary,
                icon: PhosphorIconsDuotone.password,
                expand: true,
                loading: _busy == 'pw',
                // Both fields needed and the new one long enough (R6).
                onPressed: _current.text.isEmpty || nextLen < 12 || _busy != null ? null : () => _changePassword(session),
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
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
        Row(
          children: [
            Expanded(
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
              onPressed: _code.text.length != 6 || _busy != null
                  ? null
                  : () => _run('totp', () async {
                      await Api.I.post('/auth/mfa/totp/enable', {'code': _code.text});
                      if (mounted) {
                        setState(() {
                          _totp = null;
                          _code.clear();
                        });
                      }
                      await session.refresh();
                    }, 'Authenticator app turned on'),
            ),
          ],
        ),
            // Back out of setup, like the email-code flow (R12).
            TextButton(
              onPressed: _busy != null
                  ? null
                  : () => setState(() {
                      _totp = null;
                      _code.clear();
                      _errors.remove('totp');
                    }),
              style: _link(p.muted),
              child: Text('Cancel setup', style: ts(context, size: 13, color: p.muted)),
            ),
          ],
        ),
      ),
    );
  }

  /// Signed-in devices (THREATS.md S23): own sessions only; signing others
  /// out asks for a fresh second factor (the API decides, lib/widgets/step_up.dart asks).
  Widget _devicesCard(BuildContext context, Pal p) {
    final devices = _devices;
    return TvCard(
      title: 'Signed-in devices',
      icon: PhosphorIconsDuotone.desktop,
      description: 'Where your account is signed in now. Sign out anything you don’t recognise.',
      padded: false,
      child: _swap(context, devices == null ? 'pending' : 'ready', devices == null
          ? _pending(const SkeletonRows(rows: 2))
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _cardError('devices', padding: const EdgeInsets.fromLTRB(16, 0, 16, 12)),
                RowList(
                  children: [
                    for (var i = 0; i < devices.length; i++)
                      Rise(
                        key: ValueKey(devices[i]['id']),
                        delay: (i < 8 ? i : 8) * 40,
                        child: Builder(builder: (context) {
                          final d = devices[i];
                          return Padding(
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
                                icon: PhosphorIconsDuotone.signOut,
                                loading: _busy == 'so-${d['id']}',
                                onPressed: _busy != null ? null : () => _run('so-${d['id']}', () => Api.I.delete('/auth/sessions/${d['id']}'), 'Device signed out'),
                              ),
                          ],
                        ),
                      );
                        }),
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
                      onPressed: _busy != null ? null : () => _run('others', () => Api.I.post('/auth/sessions/revoke-others'), 'Signed out everywhere else'),
                    ),
                  ),
              ],
            )),
    );
  }

  /// Admin setting: which roles must use a second factor (THREATS.md S21).
  /// The API enforces it, keeps ADMIN on, and asks for a fresh factor.
  Widget _policyCard(BuildContext context, Pal p) {
    final policy = _policy;
    const roles = [('ADMIN', 'Administrators'), ('OWNER', 'Document owners'), ('VIEWER', 'Viewers'), ('EXTERNAL', 'External partners')];
    return TvCard(
      title: 'Second factor required for',
      icon: PhosphorIconsDuotone.shieldCheck,
      description: 'Everyone in these roles must use an authenticator app or a passkey, from their next click. Admins always.',
      padded: false,
      child: _swap(context, policy == null ? 'pending' : 'ready', policy == null
          ? _pending(const SkeletonRows(rows: 3))
          : RowList(
              children: [
                if (_errors['policy'] != null) _cardError('policy', padding: const EdgeInsets.fromLTRB(16, 0, 16, 12)),
                for (final (role, label) in roles)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
                    child: Row(
                      children: [
                        Expanded(child: Text(label, style: ts(context, size: 13.5, w: FontWeight.w600))),
                        if (role == 'ADMIN') const TvBadge('Always', tone: Tone.violet, icon: PhosphorIconsDuotone.lock),
                        Switch(
                          value: role == 'ADMIN' || policy.contains(role),
                          onChanged: role == 'ADMIN' || _busy != null
                              ? null
                              : (on) => _run('policy', () async {
                                  final next = on ? [...policy, role] : policy.where((r) => r != role).toList();
                                  final r = await Api.I.put('/admin/settings/mfa-policy', {'requiredRoles': next}) as Map;
                                  if (mounted) setState(() => _policy = (r['requiredRoles'] as List).cast<String>());
                                }, 'Policy saved'),
                        ),
                      ],
                    ),
                  ),
              ],
            )),
    );
  }

  /// Face / fingerprint lock for this phone only (THREATS.md S24).
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
