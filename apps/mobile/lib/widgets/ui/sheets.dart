import 'dart:async';

import 'package:flutter/material.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';
import 'buttons.dart';
import 'cards.dart';

/* ---------------------------------------------------------- bottom sheet */

Future<T?> showSheet<T>(BuildContext context, {required String title, PI? icon, String? description, required Widget Function(BuildContext) builder}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
    builder: (ctx) {
      final p = Pal.of(ctx);
      return Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (icon != null) ...[IconTile(icon, size: 44, gradient: true), const SizedBox(width: 14)],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: ts(ctx, size: 18, w: FontWeight.w600)),
                        if (description != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 3),
                            child: Text(description, style: ts(ctx, size: 13, color: p.muted, height: 1.45)),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              builder(ctx),
            ],
          ),
        ),
      );
    },
  );
}

/* ------------------------------------------------------- confirm + error */

/// Asks before a destructive or important action. Resolves true when the
/// user confirms (and [onConfirm], if given, completes without throwing),
/// false on Cancel or when the sheet is dismissed. With [onConfirm], the
/// confirm button spins while it runs and an error is shown in the sheet,
/// which stays open.
///
///   if (!await showConfirm(context, 'Revoke access?', 'They lose access at once.', danger: true, confirmLabel: 'Revoke')) return;
Future<bool> showConfirm(
  BuildContext context,
  String title,
  String? body, {
  String confirmLabel = 'Confirm',
  String cancelLabel = 'Cancel',
  bool danger = false,
  PI? icon,
  Future<void> Function()? onConfirm,
}) async {
  final ok = await showSheet<bool>(
    context,
    title: title,
    icon: icon ?? (danger ? PhosphorIconsDuotone.warningOctagon : null),
    description: body,
    builder: (_) => _ConfirmActions(confirmLabel: confirmLabel, cancelLabel: cancelLabel, danger: danger, onConfirm: onConfirm),
  );
  return ok ?? false;
}

class _ConfirmActions extends StatefulWidget {
  const _ConfirmActions({required this.confirmLabel, required this.cancelLabel, required this.danger, this.onConfirm});
  final String confirmLabel;
  final String cancelLabel;
  final bool danger;
  final Future<void> Function()? onConfirm;
  @override
  State<_ConfirmActions> createState() => _ConfirmActionsState();
}

class _ConfirmActionsState extends State<_ConfirmActions> {
  bool _busy = false;
  String? _error;

  Future<void> _confirm() async {
    if (_busy) return;
    final run = widget.onConfirm;
    if (run == null) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await run();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  static String _message(Object e) {
    final s = e.toString();
    return s.startsWith('Exception: ') ? s.substring(11) : s;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_busy,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null) ...[TvAlert(_error!), const SizedBox(height: 14)],
          Row(
            children: [
              Expanded(
                child: Btn(widget.cancelLabel, expand: true, onPressed: _busy ? null : () => Navigator.of(context).pop(false)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Btn(
                  widget.confirmLabel,
                  expand: true,
                  variant: widget.danger ? BtnVariant.danger : BtnVariant.primary,
                  loading: _busy,
                  onPressed: _confirm,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
