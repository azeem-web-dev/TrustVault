import 'dart:async';

import 'package:flutter/material.dart';

import '../phosphor.dart';

import '../../core/theme.dart';

import 'basics.dart';
import 'buttons.dart';
import 'cards.dart';

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
