import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'buttons.dart';

/// Phosphor duotone icon, the same family the web app uses. Decorative
/// (hidden from TalkBack) unless it is given a [semanticLabel].
class Ic extends StatelessWidget {
  const Ic(this.icon, {super.key, this.size = 18, this.color, this.semanticLabel});
  final PI icon;
  final double size;
  final Color? color;
  final String? semanticLabel;
  @override
  Widget build(BuildContext context) => SvgPicture.string(
    icon.svg,
    width: size,
    height: size,
    semanticsLabel: semanticLabel,
    excludeFromSemantics: semanticLabel == null,
    colorFilter: ColorFilter.mode(color ?? IconTheme.of(context).color ?? Pal.of(context).muted, BlendMode.srcIn),
  );
}

/// Minimum touch target (Material / WCAG): 44 x 44 logical pixels.
const kMinTap = 44.0;

const gap4 = SizedBox(width: 4, height: 4);
const gap8 = SizedBox(width: 8, height: 8);
const gap12 = SizedBox(width: 12, height: 12);
const gap16 = SizedBox(width: 16, height: 16);
const gap24 = SizedBox(width: 24, height: 24);

TextStyle ts(BuildContext c, {double size = 14, FontWeight? w, Color? color, double? height, double? spacing, String? family}) =>
    TextStyle(fontSize: size, fontWeight: w, color: color ?? Pal.of(c).text, height: height, letterSpacing: spacing, fontFamily: family);

/* ------------------------------------------------------------------ motion */

/// Fade + slide up, like the web's `animate-rise`. Shows the child at once
/// when the system asks for reduced motion.
class Rise extends StatefulWidget {
  const Rise({super.key, required this.child, this.delay = 0, this.dy = 10});
  final Widget child;
  final int delay;
  final double dy;
  @override
  State<Rise> createState() => _RiseState();
}

class _RiseState extends State<Rise> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));
  late final Animation<double> _a = CurvedAnimation(parent: _c, curve: const Cubic(0.2, 0.8, 0.2, 1));
  @override
  void initState() {
    super.initState();
    Future.delayed(Duration(milliseconds: math.min(widget.delay, 400)), () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (Motion.reduced(context)) return widget.child;
    return AnimatedBuilder(
      animation: _a,
      builder: (_, child) => Opacity(
        opacity: _a.value,
        child: Transform.translate(offset: Offset(0, widget.dy * (1 - _a.value)), child: child),
      ),
      child: widget.child,
    );
  }
}

/// Pressable surface that dips slightly when touched. Exposed to TalkBack
/// as a button (with its enabled / selected state), focusable with a
/// keyboard or switch access (Enter / Space activate) and drawn with a 2px
/// brand ring while focused. No dip under reduced motion.
class Press extends StatefulWidget {
  const Press({super.key, required this.child, this.onTap, this.radius = 16, this.button = false, this.selected, this.semanticLabel});
  final Widget child;
  final VoidCallback? onTap;
  final double radius;

  /// Announce as a button even while disabled ([onTap] null), e.g. for [Btn].
  final bool button;
  final bool? selected;
  final String? semanticLabel;
  @override
  State<Press> createState() => _PressState();
}

class _PressState extends State<Press> {
  bool _down = false;
  bool _focused = false;

  void _tap() {
    final onTap = widget.onTap;
    if (onTap == null) return;
    HapticFeedback.selectionClick();
    onTap();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    final isButton = enabled || widget.button;
    final reduced = Motion.reduced(context);
    Widget child = AnimatedScale(scale: _down && !reduced ? 0.975 : 1, duration: Motion.fast, child: widget.child);
    if (_focused) {
      child = DecoratedBox(
        position: DecorationPosition.foreground,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(widget.radius),
          border: Border.all(color: Pal.of(context).dark ? C.brand400 : C.brand500, width: 2),
        ),
        child: child,
      );
    }
    return Semantics(
      container: isButton,
      button: isButton ? true : null,
      enabled: isButton ? enabled : null,
      selected: widget.selected,
      label: widget.semanticLabel,
      onTap: enabled ? _tap : null,
      child: FocusableActionDetector(
        enabled: enabled,
        mouseCursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        actions: {ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) => _tap())},
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          excludeFromSemantics: true,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapUp: enabled ? (_) => setState(() => _down = false) : null,
          onTapCancel: () => setState(() => _down = false),
          onTap: enabled ? _tap : null,
          child: child,
        ),
      ),
    );
  }
}
