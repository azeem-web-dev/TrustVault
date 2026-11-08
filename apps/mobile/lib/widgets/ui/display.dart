import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';
import 'buttons.dart';

/* --------------------------------------------------------- score ring */

class ScoreRing extends StatelessWidget {
  const ScoreRing({super.key, required this.value, required this.max, this.size = 64});
  final int value;
  final int max;
  final double size;
  @override
  Widget build(BuildContext context) {
    final color = value == max
        ? C.emerald500
        : value >= 2
        ? C.brand500
        : C.amber500;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: value / max),
      duration: const Duration(milliseconds: 800),
      curve: Curves.easeOutCubic,
      builder: (_, v, _) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _RingPainter(v, color, Pal.of(context).soft2),
          child: Center(
            child: Text('$value/$max', style: ts(context, size: 14, w: FontWeight.w700)),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.v, this.color, this.track);
  final double v;
  final Color color;
  final Color track;
  @override
  void paint(Canvas canvas, Size size) {
    final r = Rect.fromLTWH(3, 3, size.width - 6, size.height - 6);
    final base = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6
      ..color = track;
    canvas.drawArc(r, 0, math.pi * 2, false, base);
    canvas.drawArc(
      r,
      -math.pi / 2,
      math.pi * 2 * v,
      false,
      base
        ..color = color
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(_RingPainter o) => o.v != v || o.color != color;
}

/// Gradient text, like the web's `.text-gradient`.
class GradientText extends StatelessWidget {
  const GradientText(this.text, {super.key, required this.style, this.gradient = C.textGradient});
  final String text;
  final TextStyle style;
  final Gradient gradient;
  @override
  Widget build(BuildContext context) => ShaderMask(
    blendMode: BlendMode.srcIn,
    shaderCallback: (b) => gradient.createShader(Rect.fromLTWH(0, 0, b.width, b.height)),
    child: Text(text, style: style),
  );
}

class Mono extends StatelessWidget {
  const Mono(this.text, {super.key, this.size = 11.5, this.color, this.selectable = true});
  final String text;
  final double size;
  final Color? color;
  final bool selectable;
  @override
  Widget build(BuildContext context) {
    final style = TextStyle(fontFamily: C.mono, fontSize: size, height: 1.45, color: color ?? Pal.of(context).body);
    return selectable ? SelectableText(text, style: style) : Text(text, style: style);
  }
}

/// Small copy-to-clipboard button with a check-mark confirmation.
class CopyBtn extends StatefulWidget {
  const CopyBtn(this.value, {super.key, this.label = 'Copy'});
  final String value;
  final String label;
  @override
  State<CopyBtn> createState() => _CopyBtnState();
}

class _CopyBtnState extends State<CopyBtn> {
  bool _done = false;
  @override
  Widget build(BuildContext context) => IconBtn(
    _done ? PhosphorIconsBold.check : PhosphorIconsDuotone.copy,
    tooltip: widget.label,
    size: 32,
    color: _done ? C.emerald500 : null,
    onPressed: () async {
      await Clipboard.setData(ClipboardData(text: widget.value));
      if (!mounted) return;
      setState(() => _done = true);
      Future.delayed(const Duration(milliseconds: 1500), () {
        if (mounted) setState(() => _done = false);
      });
    },
  );
}

/// Shared list-row container with dividers.
class RowList extends StatelessWidget {
  const RowList({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[if (i > 0) Divider(height: 1, thickness: 1, color: p.divider), children[i]],
      ],
    );
  }
}
