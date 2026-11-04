import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'phosphor.dart';

import 'package:provider/provider.dart';

import '../core/session.dart';
import '../core/theme.dart';
import 'ui.dart';

class Logo extends StatelessWidget {
  const Logo({super.key, this.size = 28});
  final double size;
  @override
  Widget build(BuildContext context) => SvgPicture.asset('assets/art/logo.svg', width: size, height: size);
}

class Wordmark extends StatelessWidget {
  const Wordmark({super.key, this.light = false});
  final bool light;
  @override
  Widget build(BuildContext context) {
    final color = light ? Colors.white : Pal.of(context).text;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Logo(),
        const SizedBox(width: 10),
        Text(
          'Trust',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.3, color: color),
        ),
        const GradientText('Vault', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, letterSpacing: -0.3)),
      ],
    );
  }
}

/// Night-sky backdrop of the sign-in hero: glows and a faded grid.
class NightSky extends StatelessWidget {
  const NightSky({super.key});
  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: Stack(
        children: [
          const Positioned.fill(child: ColoredBox(color: C.night)),
          Positioned.fill(child: CustomPaint(painter: _GridPainter())),
          Positioned(left: -120, top: -120, child: _blob(C.brand600, .35, 340)),
          Positioned(right: -110, bottom: -140, child: _blob(C.fuchsia600, .28, 320)),
        ],
      ),
    );
  }

  Widget _blob(Color c, double o, double s) => Container(
    width: s,
    height: s,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      gradient: RadialGradient(
        colors: [
          c.withValues(alpha: o),
          c.withValues(alpha: 0),
        ],
      ),
    ),
  );
}

class _GridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final maxD = size.longestSide * .6;
    const step = 36.0;
    for (double x = 0; x <= size.width; x += step) {
      for (double y = 0; y <= size.height; y += step) {
        final d = (Offset(x, y) - center).distance;
        final o = (1 - d / maxD).clamp(0.0, 1.0) * 0.16;
        if (o <= 0) continue;
        final paint = Paint()
          ..color = C.slate400.withValues(alpha: o)
          ..strokeWidth = 1;
        canvas.drawLine(Offset(x, y), Offset(x + step, y), paint);
        canvas.drawLine(Offset(x, y), Offset(x, y + step), paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Gentle float, like the web's `animate-float`.
class FloatY extends StatefulWidget {
  const FloatY({super.key, required this.child});
  final Widget child;
  @override
  State<FloatY> createState() => _FloatYState();
}

class _FloatYState extends State<FloatY> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 7))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (Motion.reduced(context)) return widget.child;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, child) => Transform.translate(offset: Offset(0, -8 * (0.5 - 0.5 * math.cos(_c.value * 2 * math.pi))), child: child),
      child: widget.child,
    );
  }
}

/// Light / dark / system switch.
class ThemeSwitch extends StatelessWidget {
  const ThemeSwitch({super.key, this.onDark = false});
  final bool onDark;
  @override
  Widget build(BuildContext context) {
    final theme = context.watch<ThemeChoice>();
    final p = Pal.of(context);
    final items = [('light', PhosphorIconsDuotone.sun, 'Light'), ('dark', PhosphorIconsDuotone.moon, 'Dark'), ('system', PhosphorIconsDuotone.deviceMobile, 'System')];
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: onDark ? Colors.white.withValues(alpha: .07) : (p.dark ? Colors.white.withValues(alpha: .05) : C.slate100),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: onDark ? Colors.white.withValues(alpha: .1) : p.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (id, icon, label) in items)
            Tooltip(
              message: label,
              child: Semantics(
                button: true,
                selected: theme.mode == id,
                label: '$label theme',
                child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                excludeFromSemantics: true,
                onTap: () => theme.set(id),
                child: AnimatedContainer(
                  duration: Motion.of(context, const Duration(milliseconds: 180)),
                  width: 30,
                  height: 28,
                  decoration: BoxDecoration(
                    color: theme.mode == id ? (onDark ? Colors.white.withValues(alpha: .16) : (p.dark ? Colors.white.withValues(alpha: .12) : Colors.white)) : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                    boxShadow: theme.mode == id && !onDark && !p.dark ? [BoxShadow(color: C.slate900.withValues(alpha: .08), blurRadius: 4, offset: const Offset(0, 1))] : null,
                  ),
                  child: Center(child: Ic(icon, size: 15, color: theme.mode == id ? (onDark ? Colors.white : p.accent) : (onDark ? C.brand100.withValues(alpha: .6) : p.muted))),
                ),
              ),
              ),
            ),
        ],
      ),
    );
  }
}
