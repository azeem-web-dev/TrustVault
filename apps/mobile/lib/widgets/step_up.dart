import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/passkey.dart';
import '../core/theme.dart';
import 'phosphor.dart';
import 'ui.dart';

/// Shows "Confirm it's you" when the API refuses a risky action with
/// `step_up_required`. Resolves true once POST /auth/mfa/step-up succeeded,
/// and lib/core/api.dart then sends the original request again. The sheet
/// proves nothing to the API by itself (THREATS.md S20).
Future<bool> askStepUp(BuildContext context) async {
  Map? status;
  try {
    status = await Api.I.get('/auth/mfa') as Map;
  } catch (_) {
    status = null;
  }
  if (!context.mounted) return false;
  final ok = await showSheet<bool>(
    context,
    title: 'Confirm it’s you',
    icon: PhosphorIconsDuotone.shieldCheckered,
    description: 'This action needs a second factor from the last ${status?['stepUpMinutes'] ?? 5} minutes.',
    builder: (_) => _StepUpForm(
      totp: status?['totp'] != false,
      passkey: ((status?['passkeys'] as List?) ?? const []).isNotEmpty,
      email: status?['email'] == true,
      emailTo: (status?['emailTo'] as String?) ?? 'your email',
    ),
  );
  return ok == true;
}

class _StepUpForm extends StatefulWidget {
  const _StepUpForm({required this.totp, required this.passkey, required this.email, required this.emailTo});
  final bool totp;
  final bool passkey;
  /// Emailed codes are on for this account (THREATS.md S30).
  final bool email;
  final String emailTo;
  @override
  State<_StepUpForm> createState() => _StepUpFormState();
}

class _StepUpFormState extends State<_StepUpForm> {
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;
  /// Where the emailed step-up code went, once one was sent.
  String? _sentTo;

  @override
  void initState() {
    super.initState();
    _code.addListener(() => setState(() {}));
  }

  Future<void> _sendEmail() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await Api.I.post('/auth/mfa/email/send', {'purpose': 'stepup'}) as Map;
      if (mounted) {
        setState(() {
          _code.clear();
          _sentTo = r['sentTo'] as String;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _try(Future<void> Function() fn) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await fn();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final link = TextButton.styleFrom(
      foregroundColor: p.accent,
      minimumSize: const Size(kMinTap, kMinTap),
      textStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
    );
    // Passkey → emailed code: the sheet's height animates instead of jumping.
    return AnimatedSize(
      duration: Motion.of(context),
      curve: Motion.curve,
      alignment: Alignment.topCenter,
      child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null) ...[Rise(dy: 6, child: TvAlert(_error!)), gap12],
        if (widget.passkey && _sentTo == null) ...[
          Btn('Use a passkey', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.fingerprint, loading: _busy && _code.text.isEmpty, onPressed: _busy ? null : () => _try(() => Passkeys.assertTo('/auth/mfa/step-up'))),
          if (widget.totp || widget.email) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: DividerLabel('or enter a code')),
        ],
        if (widget.email && !widget.totp && _sentTo == null)
          Btn('Email a code to ${widget.emailTo}', variant: widget.passkey ? BtnVariant.secondary : BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.envelope, loading: _busy, onPressed: _busy ? null : _sendEmail),
        if (_sentTo != null) ...[
          Rise(
            dy: 6,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Ic(PhosphorIconsDuotone.envelope, size: 16, color: p.accent),
                const SizedBox(width: 6),
                Flexible(child: Text('6-digit code we emailed to $_sentTo', textAlign: TextAlign.center, style: ts(context, size: 13.5, color: p.body))),
              ],
            ),
          ),
          gap12,
        ],
        if (widget.totp || _sentTo != null) ...[
          TextField(
            controller: _code,
            autofocus: !widget.passkey || _sentTo != null,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            maxLength: 6,
            textAlign: TextAlign.center,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(fontFamily: C.mono, fontSize: 24, letterSpacing: 10),
            decoration: fieldDeco(hint: '000000').copyWith(counterText: ''),
          ),
          gap12,
          Btn(
            'Confirm and continue',
            variant: widget.passkey && _sentTo == null ? BtnVariant.secondary : BtnVariant.primary,
            size: BtnSize.lg,
            expand: true,
            icon: PhosphorIconsDuotone.shieldCheck,
            loading: _busy && _code.text.length == 6,
            onPressed: _code.text.length == 6 && !_busy
                ? () => _try(() => Api.I.post('/auth/mfa/step-up', _sentTo != null ? {'code': _code.text, 'method': 'email'} : {'code': _code.text}))
                : null,
          ),
          if (_sentTo != null) TextButton(style: link, onPressed: _busy ? null : _sendEmail, child: const Text('No email? Send a new code')),
        ],
        if (widget.email && widget.totp && _sentTo == null)
          TextButton.icon(
            style: link,
            onPressed: _busy ? null : _sendEmail,
            icon: Ic(PhosphorIconsDuotone.envelope, size: 16, color: p.accent),
            label: const Text('Email me a code instead'),
          ),
      ],
      ),
    );
  }
}
