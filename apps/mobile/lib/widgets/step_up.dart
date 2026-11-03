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
    builder: (_) => _StepUpForm(totp: status?['totp'] != false, passkey: ((status?['passkeys'] as List?) ?? const []).isNotEmpty),
  );
  return ok == true;
}

class _StepUpForm extends StatefulWidget {
  const _StepUpForm({required this.totp, required this.passkey});
  final bool totp;
  final bool passkey;
  @override
  State<_StepUpForm> createState() => _StepUpFormState();
}

class _StepUpFormState extends State<_StepUpForm> {
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _code.addListener(() => setState(() {}));
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null) ...[TvAlert(_error!), gap12],
        if (widget.passkey) ...[
          Btn('Use a passkey', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.fingerprint, loading: _busy && _code.text.isEmpty, onPressed: _busy ? null : () => _try(() => Passkeys.assertTo('/auth/mfa/step-up'))),
          if (widget.totp) const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: DividerLabel('or enter a code')),
        ],
        if (widget.totp) ...[
          TextField(
            controller: _code,
            autofocus: !widget.passkey,
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
            variant: widget.passkey ? BtnVariant.secondary : BtnVariant.primary,
            size: BtnSize.lg,
            expand: true,
            loading: _busy && _code.text.length == 6,
            onPressed: _code.text.length == 6 && !_busy ? () => _try(() => Api.I.post('/auth/mfa/step-up', {'code': _code.text})) : null,
          ),
        ],
      ],
    );
  }
}
