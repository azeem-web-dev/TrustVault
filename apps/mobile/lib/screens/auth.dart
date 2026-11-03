import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';
import '../core/api.dart';
import '../core/passkey.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/art.dart';
import '../widgets/totp_guide.dart';
import '../widgets/ui.dart';

/// Sign-in frame: the brand story on a night-sky header, the form on a sheet.
class AuthLayout extends StatelessWidget {
  const AuthLayout({super.key, required this.child, this.compact = false});
  final Widget child;
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final top = MediaQuery.of(context).padding.top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: C.night,
        body: SingleChildScrollView(
          child: Column(
            children: [
              Stack(
                children: [
                  const Positioned.fill(child: NightSky()),
                  Padding(
                    padding: EdgeInsets.fromLTRB(22, top + 14, 14, 0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [const Wordmark(light: true), const Spacer(), const ThemeSwitch(onDark: true)]),
                        if (!compact) ...[
                          const SizedBox(height: 4),
                          Center(child: FloatY(child: SvgPicture.asset('assets/art/vault_hero.svg', height: 200))),
                          Text(
                            "The wrong person can't reach it.",
                            style: ts(context, size: 23, w: FontWeight.w600, color: Colors.white, height: 1.2, spacing: -0.4),
                          ),
                          GradientText('You can prove who did.', style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w600, height: 1.25, letterSpacing: -0.4)),
                          const SizedBox(height: 12),
                          const _Points(),
                          const SizedBox(height: 34),
                        ] else ...[
                          const SizedBox(height: 18),
                          Center(child: SvgPicture.asset('assets/art/chain_ok.svg', height: 52)),
                          const SizedBox(height: 34),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
              Transform.translate(
                offset: const Offset(0, -20),
                child: Container(
                  constraints: BoxConstraints(minHeight: MediaQuery.of(context).size.height * (compact ? .72 : .5)),
                  decoration: BoxDecoration(
                    color: p.bg,
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
                  ),
                  padding: const EdgeInsets.fromLTRB(22, 28, 22, 30),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 440),
                      child: Rise(child: child),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Points extends StatelessWidget {
  const _Points();
  @override
  Widget build(BuildContext context) {
    final items = [
      (PhosphorIconsDuotone.lockKey, 'Only the right people'),
      (PhosphorIconsDuotone.linkSimpleHorizontal, 'Proof of every read'),
      (PhosphorIconsDuotone.fingerprint, 'Phishing-resistant'),
    ];
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final (icon, label) in items)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: .06),
              borderRadius: BorderRadius.circular(99),
              border: Border.all(color: Colors.white.withValues(alpha: .1)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Ic(icon, size: 14, color: C.brand200),
                const SizedBox(width: 6),
                Text(
                  label,
                  style: TextStyle(fontSize: 12, color: C.brand100.withValues(alpha: .85), fontWeight: FontWeight.w500),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/* ------------------------------------------------------------------ login */

class _Demo {
  const _Demo(this.name, this.role, this.email, this.password);
  final String name, role, email, password;
}

// The published demo accounts (also listed in the README and on the web
// sign-in page). The server protects them: nobody can change their password
// or second factor.
const _demo = [
  _Demo('Ada Admin', 'Administrator', 'admin@demo.com', 'admin1234567'),
  _Demo('Ben Admin', 'Second administrator', 'admin2@demo.com', 'admin2345678'),
  _Demo('Olivia Owner', 'Document owner', 'olivia@demo.com', 'owner1234567'),
  _Demo('Victor Viewer', 'Viewer', 'victor@demo.com', 'viewer123456'),
  _Demo('Erin External', 'External partner', 'erin@demo.com', 'external1234'),
];

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _form = GlobalKey<FormState>();
  bool _reveal = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context.read<Session>().signIn(_email.text.trim(), _password.text);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not reach the server'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return AuthLayout(
      child: Form(
        key: _form,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Welcome back', style: ts(context, size: 28, w: FontWeight.w600, spacing: -0.6)),
            const SizedBox(height: 4),
            Text('Sign in to reach the documents shared with you.', style: ts(context, size: 14, color: p.muted)),
            const SizedBox(height: 24),
            FieldLabel(
              'Email',
              child: TextFormField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.username],
                textInputAction: TextInputAction.next,
                decoration: fieldDeco(hint: 'you@company.com', icon: PhosphorIconsDuotone.envelope),
                validator: (v) => (v ?? '').trim().isEmpty ? 'Enter your email' : null,
              ),
            ),
            const SizedBox(height: 14),
            FieldLabel(
              'Password',
              child: TextFormField(
                controller: _password,
                obscureText: !_reveal,
                autofillHints: const [AutofillHints.password],
                onFieldSubmitted: (_) => _submit(),
                decoration: fieldDeco(
                  hint: '••••••••••••',
                  icon: PhosphorIconsDuotone.lockSimple,
                  suffix: IconButton(
                    tooltip: _reveal ? 'Hide characters' : 'Show characters',
                    icon: Ic(_reveal ? PhosphorIconsDuotone.eyeSlash : PhosphorIconsDuotone.eye, size: 19, color: C.slate400),
                    onPressed: () => setState(() => _reveal = !_reveal),
                  ),
                ),
                validator: (v) => (v ?? '').isEmpty ? 'Enter your password' : null,
              ),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => showSheet(
                  context,
                  title: 'Reset your password',
                  icon: PhosphorIconsDuotone.lockKey,
                  description: 'We will email you a link that works once and expires in 30 minutes.',
                  builder: (_) => _ForgotForm(initialEmail: _email.text.trim()),
                ),
                child: Text('Forgot password?', style: ts(context, size: 13, w: FontWeight.w500, color: p.accent)),
              ),
            ),
            if (_error != null) ...[const SizedBox(height: 14), TvAlert(_error!)],
            const SizedBox(height: 18),
            Btn(
              _busy ? 'Signing in…' : 'Sign in',
              variant: BtnVariant.primary,
              size: BtnSize.lg,
              expand: true,
              loading: _busy,
              trailing: _busy ? null : PhosphorIconsBold.arrowRight,
              onPressed: _submit,
            ),
            const SizedBox(height: 26),
            const DividerLabel('or try a demo account'),
            const SizedBox(height: 12),
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 2.65,
              children: [
                for (final d in _demo)
                  Press(
                    onTap: () => setState(() {
                      _email.text = d.email;
                      _password.text = d.password;
                      _error = null;
                    }),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      decoration: BoxDecoration(
                        color: _email.text == d.email ? p.selectedBg : p.card,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: _email.text == d.email ? p.selectedBorder : p.fieldBorder),
                        boxShadow: _email.text == d.email ? [BoxShadow(color: C.brand500.withValues(alpha: .1), spreadRadius: 4)] : p.shadow,
                      ),
                      child: Row(
                        children: [
                          Avatar(d.name, size: 32),
                          const SizedBox(width: 9),
                          Expanded(
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(d.name.split(' ').first, maxLines: 1, style: ts(context, size: 13, w: FontWeight.w600)),
                                Text(
                                  d.role,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ts(context, size: 11, color: p.muted),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Ic(PhosphorIconsDuotone.sparkle, size: 14, color: C.brand500),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text('Picking one fills in its login. The admin also needs a 6-digit code from the secret in the README.', style: ts(context, size: 12, color: p.muted, height: 1.5)),
                ),
              ],
            ),
            const SizedBox(height: 26),
            Text(
              'Every sign-in, download and permission change is recorded.',
              textAlign: TextAlign.center,
              style: ts(context, size: 12, color: p.faint),
            ),
          ],
        ),
      ),
    );
  }
}

class _ForgotForm extends StatefulWidget {
  const _ForgotForm({this.initialEmail = ''});
  final String initialEmail;
  @override
  State<_ForgotForm> createState() => _ForgotFormState();
}

class _ForgotFormState extends State<_ForgotForm> {
  late final _email = TextEditingController(text: widget.initialEmail);
  bool _busy = false;
  bool _done = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final email = _email.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Enter your email');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.I.post('/auth/password/forgot', {'email': email});
      if (mounted) setState(() => _done = true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not reach the server'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    if (_done) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const TvAlert('If an account exists for that email, a link is on its way. Open it on this phone or a computer.', tone: Tone.green),
          const SizedBox(height: 10),
          Text('Demo accounts cannot be reset.', style: ts(context, size: 12, color: p.muted)),
          const SizedBox(height: 14),
          Btn('Done', expand: true, onPressed: () => Navigator.of(context).pop()),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldLabel(
          'Email',
          child: TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            onSubmitted: (_) => _busy ? null : _send(),
            decoration: fieldDeco(hint: 'you@company.com', icon: PhosphorIconsDuotone.envelope),
          ),
        ),
        if (_error != null) ...[const SizedBox(height: 14), TvAlert(_error!)],
        const SizedBox(height: 16),
        Btn(
          _busy ? 'Sending…' : 'Email me a reset link',
          variant: BtnVariant.primary,
          size: BtnSize.lg,
          expand: true,
          loading: _busy,
          onPressed: _busy ? null : _send,
        ),
      ],
    );
  }
}

/* -------------------------------------------------------------------- MFA */

/// Second sign-in step. The session from the password step can only reach
/// these routes; passing here replaces it with a new, full session.
class MfaScreen extends StatefulWidget {
  const MfaScreen({super.key});
  @override
  State<MfaScreen> createState() => _MfaScreenState();
}

class _MfaScreenState extends State<MfaScreen> {
  Map? _status;
  final _code = TextEditingController();
  ({String secret, String uri})? _setup;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
    _code.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final s = await Api.I.get('/auth/mfa') as Map;
      if (!mounted) return;
      if (s['satisfied'] == true || s['required'] != true) {
        await context.read<Session>().refresh();
      } else {
        setState(() => _status = s);
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _run(Future<void> Function() fn) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await fn();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() => _run(() async {
    await Api.I.post(_setup != null ? '/auth/mfa/totp/enable' : '/auth/mfa/totp/verify', {'code': _code.text});
    if (mounted) await context.read<Session>().refresh();
  });

  /// Second step with a passkey (Credential Manager), or enrolling one as the first factor.
  Future<void> _passkey({required bool enrol}) => _run(() async {
    if (enrol) {
      await Passkeys.register('Android phone');
    } else {
      await Passkeys.assertTo('/auth/mfa/passkeys/verify');
    }
    if (mounted) await context.read<Session>().refresh();
  });

  Future<void> _startSetup() => _run(() async {
    final r = await Api.I.post('/auth/mfa/totp/setup') as Map;
    setState(() => _setup = (secret: r['secret'] as String, uri: r['otpauthUri'] as String));
  });

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final session = context.watch<Session>();
    final s = _status;
    if (s == null) {
      return AuthLayout(
        compact: true,
        child: _error != null
            ? Column(
                children: [
                  TvAlert(_error!),
                  gap16,
                  Btn('Sign out', icon: PhosphorIconsDuotone.signOut, onPressed: session.signOut),
                ],
              )
            : const Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [Skeleton(width: 200, height: 28), gap12, Skeleton(width: 280), SizedBox(height: 28), Skeleton(height: 90, radius: 18), gap12, Skeleton(height: 90, radius: 18)],
              ),
      );
    }
    final passkeys = (s['passkeys'] as List?) ?? const [];
    final totp = s['totp'] == true;
    final enrolled = totp || passkeys.isNotEmpty;
    final showCode = totp || _setup != null;

    return AuthLayout(
      compact: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Align(alignment: Alignment.centerLeft, child: IconTile(PhosphorIconsDuotone.shieldCheckered, size: 56, gradient: true)),
          const SizedBox(height: 18),
          Text(enrolled ? 'Confirm it’s you' : 'Set up a second factor', style: ts(context, size: 26, w: FontWeight.w600, spacing: -0.5)),
          const SizedBox(height: 6),
          if (enrolled)
            Text.rich(
              TextSpan(
                style: ts(context, size: 14, color: p.muted, height: 1.5),
                children: [
                  const TextSpan(text: 'Signed in as '),
                  TextSpan(
                    text: session.user?.email ?? '',
                    style: TextStyle(fontWeight: FontWeight.w600, color: p.body),
                  ),
                  const TextSpan(text: '. Your account needs a second factor.'),
                ],
              ),
            )
          else
            Text('Your account must use an authenticator app or a passkey. Choose one to continue.', style: ts(context, size: 14, color: p.muted, height: 1.5)),
          const SizedBox(height: 22),
          if (_error != null) ...[TvAlert(_error!), gap16],
          if (passkeys.isNotEmpty && _setup == null) ...[
            Btn('Use a passkey', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.fingerprint, loading: _busy && _code.text.length != 6, onPressed: _busy ? null : () => _passkey(enrol: false)),
            if (totp) const Padding(padding: EdgeInsets.symmetric(vertical: 14), child: DividerLabel('or enter a code')),
          ],
          if (showCode) ...[
            if (_setup != null) TvCard(child: TotpSetupGuide(secret: _setup!.secret, uri: _setup!.uri, child: Text('Enter it below.', style: ts(context, size: 12.5, color: p.muted)))),
            if (_setup != null) gap16,
            Row(
              children: [
                Ic(PhosphorIconsDuotone.deviceMobile, size: 16, color: p.body),
                const SizedBox(width: 8),
                Text(
                  '6-digit code from your authenticator app',
                  style: ts(context, size: 13, w: FontWeight.w500, color: p.body),
                ),
              ],
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _code,
              autofocus: true,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              maxLength: 6,
              textAlign: TextAlign.center,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              onSubmitted: (_) => _code.text.length == 6 ? _verify() : null,
              style: TextStyle(fontFamily: C.mono, fontSize: 30, fontWeight: FontWeight.w600, letterSpacing: 14, color: p.text),
              decoration: InputDecoration(
                counterText: '',
                hintText: '000000',
                hintStyle: TextStyle(fontFamily: C.mono, fontSize: 30, letterSpacing: 14, color: p.dark ? C.slate700 : C.slate200),
                contentPadding: const EdgeInsets.symmetric(vertical: 16),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(18),
                  borderSide: BorderSide(color: p.fieldBorder),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(18),
                  borderSide: BorderSide(color: p.fieldBorder),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(18),
                  borderSide: const BorderSide(color: C.brand500, width: 1.8),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                for (var i = 0; i < 6; i++) ...[
                  if (i > 0) const SizedBox(width: 6),
                  Expanded(
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 200),
                      height: 4,
                      decoration: BoxDecoration(borderRadius: BorderRadius.circular(9), gradient: i < _code.text.length ? C.brandGradient : null, color: i < _code.text.length ? null : p.soft2),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 18),
            Btn(
              _setup != null ? 'Turn on and continue' : 'Verify',
              variant: BtnVariant.primary,
              size: BtnSize.lg,
              expand: true,
              loading: _busy && _code.text.length == 6,
              onPressed: _code.text.length == 6 && !_busy ? _verify : null,
            ),
            if (_setup != null)
              TextButton.icon(
                onPressed: () => setState(() {
                  _setup = null;
                  _code.clear();
                }),
                icon: Ic(PhosphorIconsBold.arrowLeft, size: 14, color: p.muted),
                label: Text('Choose another method', style: ts(context, size: 13, color: p.muted)),
              ),
          ],
          if (!enrolled && _setup == null) ...[
            _MethodCard(
              icon: PhosphorIconsDuotone.deviceMobile,
              title: 'Use Google Authenticator',
              text: 'Or any authenticator app: a new 6-digit code every 30 seconds. Takes a minute.',
              onTap: _busy ? null : _startSetup,
              recommended: true,
            ),
            const SizedBox(height: 10),
            _MethodCard(icon: PhosphorIconsDuotone.key, title: 'Use a passkey on this phone', text: 'Your face, fingerprint or screen lock. Saved to your Google account; can’t be phished.', onTap: _busy ? null : () => _passkey(enrol: true)),
          ],
          const SizedBox(height: 12),
          TextButton.icon(
            onPressed: session.signOut,
            icon: Ic(PhosphorIconsDuotone.signOut, size: 16, color: p.muted),
            label: Text('Sign out', style: ts(context, size: 14, color: p.muted)),
          ),
        ],
      ),
    );
  }
}

class _MethodCard extends StatelessWidget {
  const _MethodCard({required this.icon, required this.title, required this.text, required this.onTap, this.recommended = false});
  final PI icon;
  final String title;
  final String text;
  final VoidCallback? onTap;
  final bool recommended;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Opacity(
      opacity: onTap == null ? .6 : 1,
      child: Press(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: p.card,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: p.border),
            boxShadow: p.shadow,
          ),
          child: Row(
            children: [
              IconTile(icon, size: 48),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(title, style: ts(context, size: 14, w: FontWeight.w600)),
                        if (recommended) const TvBadge('Recommended', tone: Tone.green),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(text, style: ts(context, size: 12, color: p.muted, height: 1.45)),
                  ],
                ),
              ),
              Ic(PhosphorIconsBold.caretRight, size: 16, color: p.faint),
            ],
          ),
        ),
      ),
    );
  }
}
