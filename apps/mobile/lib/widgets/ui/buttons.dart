import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';

/* ----------------------------------------------------------------- buttons */

enum BtnVariant { primary, secondary, danger, ghost, soft }

enum BtnSize { sm, md, lg }

class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onPressed, this.variant = BtnVariant.secondary, this.size = BtnSize.md, this.icon, this.trailing, this.loading = false, this.expand = false});
  final String label;
  final VoidCallback? onPressed;
  final BtnVariant variant;
  final BtnSize size;
  final PI? icon;
  final PI? trailing;
  final bool loading;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final disabled = onPressed == null || loading;
    // Drawn height; the tap area is never under [kMinTap] (sm is drawn at
    // 36 inside a 44 hit box).
    final h = switch (size) {
      BtnSize.sm => 36.0,
      BtnSize.md => 44.0,
      BtnSize.lg => 50.0,
    };
    final fs = switch (size) {
      BtnSize.sm => 13.0,
      BtnSize.md => 14.0,
      BtnSize.lg => 15.0,
    };
    final isz = switch (size) {
      BtnSize.sm => 15.0,
      BtnSize.md => 18.0,
      BtnSize.lg => 19.0,
    };
    Color fg;
    BoxDecoration deco;
    final r = BorderRadius.circular(size == BtnSize.lg ? 14 : 11);
    switch (variant) {
      case BtnVariant.primary:
        fg = Colors.white;
        deco = BoxDecoration(gradient: C.brandGradient, borderRadius: r, boxShadow: disabled ? null : C.glow);
      case BtnVariant.danger:
        fg = Colors.white;
        deco = BoxDecoration(
          color: C.red600,
          borderRadius: r,
          boxShadow: disabled ? null : [BoxShadow(color: C.red600.withValues(alpha: .35), blurRadius: 14, offset: const Offset(0, 6), spreadRadius: -6)],
        );
      case BtnVariant.ghost:
        fg = p.body;
        deco = BoxDecoration(borderRadius: r);
      case BtnVariant.soft:
        fg = p.accent;
        deco = BoxDecoration(color: p.dark ? C.brand500.withValues(alpha: .15) : C.brand50, borderRadius: r);
      case BtnVariant.secondary:
        fg = p.text;
        deco = BoxDecoration(
          color: p.field,
          borderRadius: r,
          border: Border.all(color: p.fieldBorder),
          boxShadow: p.dark ? null : const [BoxShadow(color: Color(0x0D0F172A), blurRadius: 2, offset: Offset(0, 1))],
        );
    }
    final content = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (loading)
          SizedBox(
            width: isz - 2,
            height: isz - 2,
            child: CircularProgressIndicator(strokeWidth: 2, color: fg),
          )
        else if (icon != null)
          Ic(icon!, size: isz, color: fg),
        if (loading || icon != null) SizedBox(width: size == BtnSize.sm ? 6 : 8),
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: fg, fontSize: fs, fontWeight: FontWeight.w600),
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 6), Ic(trailing!, size: isz - 2, color: fg)],
      ],
    );
    return Opacity(
      opacity: disabled && !loading ? 0.5 : 1,
      child: Press(
        onTap: disabled ? null : onPressed,
        button: true,
        radius: size == BtnSize.lg ? 14 : 11,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: kMinTap, minWidth: kMinTap),
          child: Align(
            widthFactor: 1,
            heightFactor: 1,
            child: Container(
              height: h,
              padding: EdgeInsets.symmetric(horizontal: size == BtnSize.sm ? 12 : 16),
              decoration: deco,
              child: loading ? Semantics(label: 'Working', child: content) : content,
            ),
          ),
        ),
      ),
    );
  }
}

class IconBtn extends StatelessWidget {
  const IconBtn(this.icon, {super.key, required this.tooltip, this.onPressed, this.color, this.size = 38, this.danger = false});
  final PI icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final Color? color;
  final double size;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    // The icon scales with [size]; the touch area never drops under [kMinTap].
    final hit = math.max(size, kMinTap);
    final tint = color ?? (danger ? C.red500 : p.muted);
    return Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onPressed,
          splashColor: danger ? C.red500.withValues(alpha: .15) : null,
          child: SizedBox(
            width: hit,
            height: hit,
            child: Center(
              child: Ic(icon, size: size * 0.5, color: onPressed == null ? tint.withValues(alpha: .45) : tint),
            ),
          ),
        ),
      ),
    );
  }
}
