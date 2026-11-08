import 'package:flutter/material.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';
import 'buttons.dart';

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
