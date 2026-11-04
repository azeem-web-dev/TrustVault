import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'phosphor.dart';

import '../core/format.dart';
import '../core/theme.dart';

export 'phosphor.dart' show PI;

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

/* ------------------------------------------------------------------ badges */

class TvBadge extends StatelessWidget {
  const TvBadge(this.text, {super.key, this.tone = Tone.neutral, this.dot = false, this.icon});
  final String text;
  final Tone tone;
  final bool dot;
  final PI? icon;
  @override
  Widget build(BuildContext context) {
    final t = toneOf(tone, Pal.of(context).dark);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: t.bg,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: t.ring),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: t.dot, shape: BoxShape.circle),
            ),
            const SizedBox(width: 5),
          ],
          if (icon != null) ...[Ic(icon!, size: 12, color: t.fg), const SizedBox(width: 4)],
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: t.fg, fontSize: 11, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

const accessTone = {'OWNER': Tone.violet, 'MANAGE': Tone.blue, 'EDIT': Tone.amber, 'READ': Tone.green, 'VIEW': Tone.neutral, 'NONE': Tone.neutral};
const accessLabel = {'OWNER': 'Owner', 'MANAGE': 'Manage', 'EDIT': 'Edit', 'READ': 'Download', 'VIEW': 'View only', 'NONE': 'None'};
const outcomeTone = {'ALLOWED': Tone.green, 'DENIED': Tone.red, 'FAILED': Tone.amber};

/* ---------------------------------------------------------------- surfaces */

class TvCard extends StatelessWidget {
  const TvCard({super.key, this.title, this.icon, this.description, this.actions, required this.child, this.padded = true, this.color, this.borderColor});
  final String? title;
  final PI? icon;
  final String? description;
  final Widget? actions;
  final Widget child;
  final bool padded;
  final Color? color;
  final Color? borderColor;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    // A Material (not a bare Container) so InkWell / ListTile ripples inside
    // the card are visible and clipped to its corners (M12).
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(18), boxShadow: p.shadow),
      child: Material(
      color: color ?? p.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: borderColor ?? p.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (title != null)
            Padding(
              padding: EdgeInsets.fromLTRB(18, 16, 14, padded ? 4 : 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (icon != null) ...[IconTile(icon!, size: 36, tone: Tone.brand), const SizedBox(width: 12)],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 2),
                        Text(title!, style: ts(context, size: 15, w: FontWeight.w600)),
                        if (description != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(description!, style: ts(context, size: 12.5, color: p.muted, height: 1.4)),
                          ),
                      ],
                    ),
                  ),
                  if (actions != null) ...[const SizedBox(width: 8), actions!],
                ],
              ),
            ),
          if (padded) Padding(padding: EdgeInsets.fromLTRB(18, title != null ? 12 : 18, 18, 18), child: child) else child,
        ],
      ),
      ),
    );
  }
}

class IconTile extends StatelessWidget {
  const IconTile(this.icon, {super.key, this.tone = Tone.brand, this.size = 40, this.gradient = false});
  final PI icon;
  final Tone tone;
  final double size;
  final bool gradient;
  @override
  Widget build(BuildContext context) {
    final t = toneOf(tone, Pal.of(context).dark);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: gradient ? C.brandGradient : null,
        color: gradient ? null : t.bg,
        borderRadius: BorderRadius.circular(size * 0.3),
        border: gradient ? null : Border.all(color: t.ring.withValues(alpha: .6)),
        boxShadow: gradient ? C.glow : null,
      ),
      child: Center(
        child: Ic(icon, size: size * 0.5, color: gradient ? Colors.white : t.fg),
      ),
    );
  }
}

class StatCard extends StatelessWidget {
  const StatCard({super.key, required this.label, required this.value, required this.icon, this.tone = Tone.brand, this.hint, this.delay = 0, this.onTap});
  final String label;
  final String value;
  final PI icon;
  final Tone tone;
  final String? hint;
  final int delay;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final t = toneOf(tone, p.dark);
    return Rise(
      delay: delay,
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
          clipBehavior: Clip.antiAlias,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Positioned(
                right: -30,
                top: -30,
                child: Container(
                  width: 90,
                  height: 90,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: t.dot.withValues(alpha: p.dark ? .14 : .10),
                  ),
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, size: 12, w: FontWeight.w500, color: p.muted),
                        ),
                      ),
                      IconTile(icon, size: 32, tone: tone),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(context, size: 26, w: FontWeight.w600, spacing: -0.5),
                  ),
                  if (hint != null)
                    Text(
                      hint!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, size: 11.5, color: p.muted),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Two-column grid of stat cards that keeps equal heights.
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i += 2) {
      rows.add(
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: children[i]),
              const SizedBox(width: 12),
              Expanded(child: i + 1 < children.length ? children[i + 1] : const SizedBox()),
            ],
          ),
        ),
      );
      if (i + 2 < children.length) rows.add(const SizedBox(height: 12));
    }
    return Column(children: rows);
  }
}

/* ------------------------------------------------------------------ alerts */

class TvAlert extends StatelessWidget {
  const TvAlert(this.message, {super.key, this.tone = Tone.red, this.title, this.onDismiss, this.action});
  final String message;
  final Tone tone;
  final String? title;
  final VoidCallback? onDismiss;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final dark = Pal.of(context).dark;
    final t = toneOf(tone, dark);
    final icon = switch (tone) {
      Tone.green => PhosphorIconsDuotone.checkCircle,
      Tone.amber || Tone.orange => PhosphorIconsDuotone.warning,
      Tone.blue => PhosphorIconsDuotone.info,
      _ => PhosphorIconsDuotone.warningOctagon,
    };
    return Rise(
      dy: 6,
      child: Container(
        padding: EdgeInsets.fromLTRB(14, 12, onDismiss != null ? 0 : 8, onDismiss != null ? 2 : 12),
        decoration: BoxDecoration(
          color: t.bg,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: t.ring),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Ic(icon, size: 20, color: t.dot),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (title != null)
                    Text(
                      title!,
                      style: TextStyle(color: t.fg, fontWeight: FontWeight.w600, fontSize: 14),
                    ),
                  Text(message, style: TextStyle(color: t.fg, fontSize: 13.5, height: 1.4)),
                  if (action != null) Padding(padding: const EdgeInsets.only(top: 6), child: action!),
                ],
              ),
            ),
            if (onDismiss != null)
              Transform.translate(
                offset: const Offset(4, -10),
                child: IconBtn(PhosphorIconsBold.x, tooltip: 'Dismiss', size: 28, color: t.fg, onPressed: onDismiss),
              ),
          ],
        ),
      ),
    );
  }
}

void toast(BuildContext context, String message, {Tone tone = Tone.green}) {
  final m = ScaffoldMessenger.maybeOf(context);
  if (m == null) return;
  final icon = switch (tone) {
    Tone.red => PhosphorIconsFill.warningOctagon,
    Tone.amber || Tone.orange => PhosphorIconsFill.warning,
    Tone.blue => PhosphorIconsFill.info,
    _ => PhosphorIconsFill.checkCircle,
  };
  final color = switch (tone) {
    Tone.red => C.red500,
    Tone.amber => C.amber500,
    Tone.orange => C.orange500,
    Tone.blue => C.sky500,
    _ => C.emerald500,
  };
  m.hideCurrentSnackBar();
  m.showSnackBar(
    SnackBar(
      behavior: SnackBarBehavior.floating,
      backgroundColor: C.slate900,
      elevation: 8,
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      content: Row(
        children: [
          Ic(icon, size: 20, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: Colors.white, fontSize: 13.5, fontFamily: 'Geist'),
            ),
          ),
        ],
      ),
    ),
  );
}

/* ----------------------------------------------------------------- avatars */

const _avatarGradients = [
  [Color(0xFF6366F1), Color(0xFF8B5CF6)],
  [Color(0xFF0EA5E9), Color(0xFF6366F1)],
  [Color(0xFF10B981), Color(0xFF14B8A6)],
  [Color(0xFFF59E0B), Color(0xFFF97316)],
  [Color(0xFFF43F5E), Color(0xFFEC4899)],
  [Color(0xFFD946EF), Color(0xFFA855F7)],
  [Color(0xFF06B6D4), Color(0xFF3B82F6)],
  [Color(0xFF84CC16), Color(0xFF10B981)],
];

class Avatar extends StatelessWidget {
  const Avatar(this.name, {super.key, this.size = 36});
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) {
    var h = 0;
    for (final r in name.runes) {
      final unit = r > 0xFFFF ? 0xD800 + ((r - 0x10000) >> 10) : r;
      h = (h * 31 + unit) & 0xFFFFFFFF;
    }
    final g = _avatarGradients[h % _avatarGradients.length];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: g),
        border: Border.all(color: Pal.of(context).dark ? C.ink950 : Colors.white, width: size > 30 ? 2 : 1.5),
      ),
      child: Center(
        child: Text(
          initials(name),
          style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: size * 0.36),
        ),
      ),
    );
  }
}

class AvatarStack extends StatelessWidget {
  const AvatarStack(this.names, {super.key, this.max = 5, this.size = 30});
  final List<String> names;
  final int max;
  final double size;
  @override
  Widget build(BuildContext context) {
    final shown = names.take(max).toList();
    final extra = names.length - shown.length;
    final count = shown.length + (extra > 0 ? 1 : 0);
    final p = Pal.of(context);
    return SizedBox(
      height: size,
      width: count == 0 ? 0 : size + (count - 1) * size * 0.72,
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * size * 0.72,
              child: Avatar(shown[i], size: size),
            ),
          if (extra > 0)
            Positioned(
              left: shown.length * size * 0.72,
              child: Container(
                width: size,
                height: size,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: p.soft2,
                  border: Border.all(color: p.dark ? C.ink950 : Colors.white, width: 2),
                ),
                child: Center(
                  child: Text(
                    '+$extra',
                    style: ts(context, size: 10.5, w: FontWeight.w600, color: p.body),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/* --------------------------------------------------------------- file icon */

class FileKind {
  const FileKind(this.label, this.icon, this.colors);
  final String label;
  final PI icon;
  final List<Color> colors;
}

FileKind fileType(String? fileName) {
  final ext = (fileName ?? '').contains('.') ? fileName!.split('.').last.toLowerCase() : '';
  switch (ext) {
    case 'pdf':
      return FileKind('PDF', PhosphorIconsDuotone.filePdf, const [Color(0xFFF43F5E), Color(0xFFDC2626)]);
    case 'doc':
    case 'docx':
      return FileKind('Word', PhosphorIconsDuotone.fileDoc, const [Color(0xFF0EA5E9), Color(0xFF2563EB)]);
    case 'xls':
    case 'xlsx':
      return FileKind('Excel', PhosphorIconsDuotone.fileXls, const [Color(0xFF10B981), Color(0xFF16A34A)]);
    case 'ppt':
    case 'pptx':
      return FileKind('PowerPoint', PhosphorIconsDuotone.filePpt, const [Color(0xFFFB923C), Color(0xFFEA580C)]);
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return FileKind('Image', PhosphorIconsDuotone.fileImage, const [Color(0xFFD946EF), Color(0xFF7C3AED)]);
    case 'csv':
      return FileKind('CSV', PhosphorIconsDuotone.fileCsv, const [Color(0xFF14B8A6), Color(0xFF0891B2)]);
    case 'md':
      return FileKind('Markdown', PhosphorIconsDuotone.fileMd, const [Color(0xFF64748B), Color(0xFF334155)]);
    case 'txt':
      return FileKind('Text', PhosphorIconsDuotone.fileTxt, const [Color(0xFF94A3B8), Color(0xFF475569)]);
    default:
      return FileKind(ext.isEmpty ? 'File' : ext.toUpperCase(), PhosphorIconsDuotone.file, const [Color(0xFF94A3B8), Color(0xFF475569)]);
  }
}

class FileIcon extends StatelessWidget {
  const FileIcon(this.fileName, {super.key, this.size = 40});
  final String? fileName;
  final double size;
  @override
  Widget build(BuildContext context) {
    final k = fileType(fileName);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.28),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: k.colors),
        border: Border.all(color: Colors.white.withValues(alpha: .2)),
        boxShadow: [BoxShadow(color: k.colors.last.withValues(alpha: .25), blurRadius: 8, offset: const Offset(0, 3), spreadRadius: -2)],
      ),
      child: Center(
        child: Ic(k.icon, size: size * 0.5, color: Colors.white),
      ),
    );
  }
}

/* ------------------------------------------------------- empty and loading */

class SpotArt extends StatelessWidget {
  const SpotArt(this.icon, {super.key, this.tone = Tone.brand});
  final PI icon;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final t = toneOf(tone, Pal.of(context).dark);
    return SizedBox(
      width: 120,
      height: 96,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Container(
            width: 96,
            height: 96,
            decoration: BoxDecoration(shape: BoxShape.circle, color: t.dot.withValues(alpha: .08)),
          ),
          Container(
            width: 70,
            height: 70,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: t.dot.withValues(alpha: .25), width: 1.2),
            ),
          ),
          Positioned(
            left: 10,
            top: 18,
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(shape: BoxShape.circle, color: t.dot.withValues(alpha: .5)),
            ),
          ),
          Positioned(
            right: 14,
            bottom: 14,
            child: Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(shape: BoxShape.circle, color: t.dot.withValues(alpha: .4)),
            ),
          ),
          Positioned(right: 18, top: 10, child: Ic(PhosphorIconsFill.sparkle, size: 12, color: t.dot.withValues(alpha: .6))),
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(
              color: t.bg,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: t.ring),
              boxShadow: Pal.of(context).shadow,
            ),
            child: Center(child: Ic(icon, size: 28, color: t.fg)),
          ),
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.body, this.action, this.tone = Tone.brand});
  final PI icon;
  final String title;
  final String? body;
  final Widget? action;
  final Tone tone;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 36),
      child: Column(
        children: [
          SpotArt(icon, tone: tone),
          const SizedBox(height: 14),
          Text(
            title,
            textAlign: TextAlign.center,
            style: ts(context, size: 16, w: FontWeight.w600),
          ),
          if (body != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                body!,
                textAlign: TextAlign.center,
                style: ts(context, size: 13, color: p.muted, height: 1.5),
              ),
            ),
          if (action != null) Padding(padding: const EdgeInsets.only(top: 16), child: action!),
        ],
      ),
    );
  }
}

class Skeleton extends StatefulWidget {
  const Skeleton({super.key, this.width, this.height = 14, this.radius = 8});
  final double? width;
  final double height;
  final double radius;
  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final base = C.slate400.withValues(alpha: .12);
    final hi = C.slate400.withValues(alpha: .26);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) {
        final x = -1.0 + 3 * _c.value;
        return Container(
          width: widget.width,
          height: widget.height,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(widget.radius),
            gradient: LinearGradient(begin: Alignment(x - 1, 0), end: Alignment(x, 0), colors: [base, hi, base]),
          ),
        );
      },
    );
  }
}

class SkeletonRows extends StatelessWidget {
  const SkeletonRows({super.key, this.rows = 4});
  final int rows;
  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading',
      liveRegion: true,
      child: ExcludeSemantics(
      child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          for (var i = 0; i < rows; i++)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  const Skeleton(width: 40, height: 40, radius: 12),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Skeleton(width: 160.0 + (i % 3) * 30, height: 13),
                        const SizedBox(height: 8),
                        const Skeleton(width: 110, height: 10),
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
    );
  }
}

/* ------------------------------------------------------------ page header */

class PageTitle extends StatelessWidget {
  const PageTitle({super.key, required this.title, required this.icon, this.eyebrow, this.subtitle, this.actions});
  final String title;
  final PI icon;
  final String? eyebrow;
  final String? subtitle;
  final List<Widget>? actions;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Rise(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                IconTile(icon, size: 48, gradient: true),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (eyebrow != null)
                        Text(
                          eyebrow!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, size: 12.5, w: FontWeight.w600, color: p.accent),
                        ),
                      Text(title, style: ts(context, size: 26, w: FontWeight.w600, spacing: -0.6, height: 1.15)),
                    ],
                  ),
                ),
              ],
            ),
            if (subtitle != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(subtitle!, style: ts(context, size: 13, color: p.muted, height: 1.5)),
              ),
            if (actions != null && actions!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Wrap(spacing: 8, runSpacing: 8, children: actions!),
              ),
          ],
        ),
      ),
    );
  }
}

/* ------------------------------------------------------------ segmented */

class SegOption<T> {
  const SegOption(this.id, this.label, {this.icon, this.count});
  final T id;
  final String label;
  final PI? icon;
  final int? count;
}

class Segmented<T> extends StatelessWidget {
  const Segmented({super.key, required this.value, required this.options, required this.onChanged, this.expand = false});
  final T value;
  final List<SegOption<T>> options;
  final ValueChanged<T> onChanged;
  final bool expand;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    Widget item(SegOption<T> o) {
      final on = o.id == value;
      return Press(
        onTap: () => onChanged(o.id),
        selected: on,
        radius: 10,
        child: AnimatedContainer(
          duration: Motion.of(context),
          curve: Curves.easeOut,
          constraints: const BoxConstraints(minHeight: 38),
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: on ? (p.dark ? Colors.white.withValues(alpha: .10) : Colors.white) : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            boxShadow: on && !p.dark ? [BoxShadow(color: C.slate900.withValues(alpha: .08), blurRadius: 6, offset: const Offset(0, 2))] : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (o.icon != null) ...[Ic(o.icon!, size: 16, color: on ? p.accent : p.muted), const SizedBox(width: 6)],
              Text(
                o.label,
                style: ts(context, size: 13, w: FontWeight.w600, color: on ? p.text : p.muted),
              ),
              if (o.count != null) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(color: on ? (p.dark ? C.brand500.withValues(alpha: .25) : C.brand100) : p.soft2, borderRadius: BorderRadius.circular(6)),
                  child: Text(
                    '${o.count}',
                    style: ts(context, size: 11, w: FontWeight.w600, color: on ? p.accent : p.muted),
                  ),
                ),
              ],
            ],
          ),
        ),
      );
    }

    final box = Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: p.dark ? Colors.white.withValues(alpha: .04) : C.slate100.withValues(alpha: .9),
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: p.border),
      ),
      child: expand ? Row(children: [for (final o in options) Expanded(child: item(o))]) : Row(mainAxisSize: MainAxisSize.min, children: [for (final o in options) item(o)]),
    );
    return expand ? box : SingleChildScrollView(scrollDirection: Axis.horizontal, child: box);
  }
}

/* ------------------------------------------------------------------ chips */

class TvChip extends StatelessWidget {
  const TvChip(this.label, {super.key, this.icon, this.selected = false, this.onTap, this.danger = false});
  final String label;
  final PI? icon;
  final bool selected;
  final VoidCallback? onTap;
  final bool danger;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final Color fg = selected ? Colors.white : (danger ? (p.dark ? C.red300 : C.red600) : p.body);
    return Press(
      onTap: onTap,
      selected: selected,
      radius: 99,
      child: AnimatedContainer(
        duration: Motion.of(context, const Duration(milliseconds: 180)),
        constraints: const BoxConstraints(minHeight: 36),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          gradient: selected && !danger ? C.brandGradient : null,
          color: selected ? (danger ? C.red600 : null) : (danger ? (p.dark ? C.red500.withValues(alpha: .1) : Colors.white) : p.field),
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: selected ? Colors.transparent : (danger ? (p.dark ? C.red500.withValues(alpha: .3) : C.red200) : p.fieldBorder)),
          boxShadow: selected && !danger ? C.glow : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[Ic(icon!, size: 14, color: fg), const SizedBox(width: 5)],
            Text(
              label,
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: fg),
            ),
          ],
        ),
      ),
    );
  }
}

/* ----------------------------------------------------------------- fields */

class FieldLabel extends StatelessWidget {
  const FieldLabel(this.label, {super.key, required this.child, this.hint});
  final String label;
  final String? hint;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: ts(context, size: 13, w: FontWeight.w500, color: p.body),
        ),
        const SizedBox(height: 6),
        child,
        if (hint != null)
          Padding(
            padding: const EdgeInsets.only(top: 5),
            child: Text(hint!, style: ts(context, size: 11.5, color: p.muted)),
          ),
      ],
    );
  }
}

InputDecoration fieldDeco({String? hint, PI? icon, Widget? suffix}) => InputDecoration(
  hintText: hint,
  prefixIcon: icon == null
      ? null
      : Padding(
          padding: const EdgeInsets.only(left: 12, right: 8),
          child: Ic(icon, size: 18, color: C.slate400),
        ),
  prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
  suffixIcon: suffix,
);

class DividerLabel extends StatelessWidget {
  const DividerLabel(this.label, {super.key});
  final String label;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Row(
      children: [
        Expanded(child: Divider(color: p.border)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(
            label.toUpperCase(),
            style: ts(context, size: 10.5, w: FontWeight.w600, color: p.faint, spacing: 0.8),
          ),
        ),
        Expanded(child: Divider(color: p.border)),
      ],
    );
  }
}

/// Selectable card (access levels, roles), like the web's radio cards.
class ChoiceCard extends StatelessWidget {
  const ChoiceCard({super.key, required this.icon, required this.title, required this.text, required this.selected, required this.onTap});
  final PI icon;
  final String title;
  final String text;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Press(
      onTap: onTap,
      selected: selected,
      radius: 14,
      child: AnimatedContainer(
        duration: Motion.of(context, const Duration(milliseconds: 180)),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: selected ? p.selectedBg : Colors.transparent,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? p.selectedBorder : p.fieldBorder, width: selected ? 1.5 : 1),
          boxShadow: selected ? [BoxShadow(color: C.brand500.withValues(alpha: .10), blurRadius: 0, spreadRadius: 4)] : null,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Ic(icon, size: 19, color: selected ? p.accent : p.muted),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: ts(context, size: 13.5, w: FontWeight.w600)),
                  Text(text, style: ts(context, size: 12, color: p.muted)),
                ],
              ),
            ),
            AnimatedOpacity(
              opacity: selected ? 1 : 0,
              duration: const Duration(milliseconds: 150),
              child: Ic(PhosphorIconsFill.checkCircle, size: 18, color: p.accent),
            ),
          ],
        ),
      ),
    );
  }
}

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

/// A load failed (instead of an endless spinner or a misleading empty
/// state): says so and offers Try again. [onRetry] may be async; the button
/// spins until it completes. [compact] renders an inline alert for cards.
class ErrorState extends StatefulWidget {
  const ErrorState({super.key, this.message, this.onRetry, this.title = 'Could not load this', this.compact = false});
  final String? message;
  final FutureOr<void> Function()? onRetry;
  final String title;
  final bool compact;
  @override
  State<ErrorState> createState() => _ErrorStateState();
}

class _ErrorStateState extends State<ErrorState> {
  bool _busy = false;

  Future<void> _retry() async {
    final run = widget.onRetry;
    if (run == null || _busy) return;
    setState(() => _busy = true);
    try {
      await run();
    } catch (_) {
      // The caller shows the new error through [message].
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.message ?? 'Check your connection and try again.';
    final retry = widget.onRetry == null
        ? null
        : Btn('Try again', icon: PhosphorIconsDuotone.arrowClockwise, size: widget.compact ? BtnSize.sm : BtnSize.md, loading: _busy, onPressed: _retry);
    if (widget.compact) return TvAlert(message, title: widget.title, action: retry);
    return Semantics(
      liveRegion: true,
      child: EmptyState(icon: PhosphorIconsDuotone.warningOctagon, tone: Tone.red, title: widget.title, body: message, action: retry),
    );
  }
}
