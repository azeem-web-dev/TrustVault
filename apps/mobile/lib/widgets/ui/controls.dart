import 'package:flutter/material.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';
import 'cards.dart';

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
