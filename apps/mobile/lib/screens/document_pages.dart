import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/secure_screen.dart';
import '../core/theme.dart';
import '../widgets/phosphor.dart';
import '../widgets/ui.dart';
import 'shell.dart';

/// Pages drawn by the server, with the viewer's email, the time and a trace
/// code across each one (THREATS.md V2-V4). Held in memory only while this
/// screen is open: nothing is written to the phone. FLAG_SECURE is on, so
/// screenshots and recordings are black and Recents shows nothing (V3).
class DocumentPagesScreen extends StatefulWidget {
  const DocumentPagesScreen({super.key, required this.documentId, required this.title, required this.viewOnly});
  final String documentId;
  final String title;
  final bool viewOnly;
  @override
  State<DocumentPagesScreen> createState() => _DocumentPagesScreenState();
}

class _DocumentPagesScreenState extends State<DocumentPagesScreen> {
  final _pages = <int, Uint8List>{};
  final _loading = <int>{};
  /// A page that failed to load (rate limit, network blip) shows its own
  /// error and Retry; the pages around it keep working.
  final _pageErrors = <int, String>{};
  final _controller = PageController();
  int _count = 0;
  int _page = 1;
  /// The page list itself could not be loaded, or access has ended (404).
  String? _error;
  bool _ended = false;
  String? _notice;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    SecureScreen.hold();
    _load();
  }

  @override
  void dispose() {
    _pages.clear();
    _controller.dispose();
    SecureScreen.release();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/${widget.documentId}/pages') as Map;
      if (!mounted) return;
      setState(() {
        _ready = true;
        _error = null;
        _count = (r['pages'] as num).toInt();
        if (r['preview'] != true) _notice = r['message'] as String?;
      });
      if (_count > 0) {
        _fetch(1);
        _fetch(2);
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  void _retryPage(int n) {
    setState(() => _pageErrors.remove(n));
    _fetch(n);
  }

  Future<void> _fetch(int n) async {
    if (_ended || _pages.containsKey(n) || _loading.contains(n) || _pageErrors.containsKey(n) || n < 1 || n > _count) return;
    _loading.add(n);
    try {
      final d = await Api.I.download('/documents/${widget.documentId}/pages/$n', fallbackName: 'page.png');
      if (!mounted) return;
      setState(() {
        // Keep a few pages around the current one; drop the rest.
        _pages.removeWhere((k, _) => (k - _page).abs() > 3);
        _pages[n] = Uint8List.fromList(d.bytes);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        if (e is ApiError && e.status == 404) {
          // Access has ended: no page of it may stay on screen.
          _pages.clear();
          _ended = true;
          _error = 'This page is no longer available to you. Your access may have ended.';
        } else {
          _pageErrors[n] = errorText(e, 'This page could not be loaded.');
        }
      });
    } finally {
      _loading.remove(n);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(child: Backdrop(dark: p.dark)),
          SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
                  child: Row(
                    children: [
                      IconBtn(PhosphorIconsBold.arrowLeft, tooltip: 'Back', color: p.muted, onPressed: () => Navigator.pop(context)),
                      gap4,
                      Expanded(
                        child: Semantics(
                          header: true,
                          child: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ts(context, size: 15, w: FontWeight.w600)),
                        ),
                      ),
                      if (widget.viewOnly) const TvBadge('View only', icon: PhosphorIconsDuotone.eyeSlash),
                      if (_count > 1) ...[
                        gap8,
                        Semantics(
                          liveRegion: true,
                          label: 'Page $_page of $_count',
                          child: ExcludeSemantics(child: Text('$_page / $_count', style: ts(context, size: 12, color: p.muted))),
                        ),
                      ],
                    ],
                  ),
                ),
                Expanded(
                  child: AnimatedSwitcher(duration: Motion.of(context, Motion.base), switchInCurve: Motion.easeOut, child: _body(context, p)),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 1),
                        child: Ic(PhosphorIconsDuotone.shieldCheck, size: 14, color: p.subtle),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          'Every page carries your name, the time and a trace code, and each view is recorded.',
                          textAlign: TextAlign.center,
                          style: ts(context, size: 12, color: p.subtle, height: 1.4),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context, Pal p) {
    if (_error != null) {
      return ListView(
        key: const ValueKey('error'),
        padding: const EdgeInsets.all(16),
        children: [
          TvCard(
            padded: false,
            child: ErrorState(
              title: _ended ? 'Access ended' : 'Could not open the pages',
              message: _error,
              // Access that has ended stays shut; anything else may be retried.
              onRetry: _ended ? null : _load,
            ),
          ),
        ],
      );
    }
    if (!_ready) return const Padding(key: ValueKey('loading'), padding: EdgeInsets.all(16), child: Skeleton(height: 420, radius: 14));
    if (_notice != null) return Padding(key: const ValueKey('notice'), padding: const EdgeInsets.all(16), child: TvAlert(_notice!, tone: Tone.amber, title: 'No preview for this file type'));
    if (_count == 0) {
      return const Padding(
        key: ValueKey('empty'),
        padding: EdgeInsets.all(16),
        child: TvCard(child: EmptyState(icon: PhosphorIconsDuotone.fileMagnifyingGlass, title: 'No pages to show', body: 'This file has no pages that can be previewed.', tone: Tone.amber)),
      );
    }
    return PageView.builder(
      key: const ValueKey('pages'),
      controller: _controller,
      itemCount: _count,
      onPageChanged: (i) {
        setState(() => _page = i + 1);
        _fetch(i + 1);
        // Prefetch the next page so swiping rarely shows a placeholder.
        _fetch(i + 2);
      },
      itemBuilder: (context, i) => AnimatedSwitcher(
        duration: Motion.of(context, Motion.base),
        switchInCurve: Motion.easeOut,
        child: _pageView(context, i + 1),
      ),
    );
  }

  /// One page: its error with Retry, a skeleton while loading, or the image.
  /// Keyed by state so the skeleton fades into the page.
  Widget _pageView(BuildContext context, int n) {
    final bytes = _pages[n];
    final err = _pageErrors[n];
    if (err != null) {
      return Center(
        key: ValueKey('err-$n'),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: TvAlert(
            err,
            title: 'Page $n could not be loaded',
            action: Btn('Retry', size: BtnSize.sm, icon: PhosphorIconsDuotone.arrowClockwise, onPressed: () => _retryPage(n)),
          ),
        ),
      );
    }
    if (bytes == null) {
      // Evicted or not reached yet: load it after this frame, never during build.
      if (!_loading.contains(n)) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _fetch(n);
        });
      }
      return Padding(
        key: ValueKey('loading-$n'),
        padding: const EdgeInsets.all(16),
        child: Semantics(label: 'Loading page $n', child: const Skeleton(height: 420, radius: 14)),
      );
    }
    return InteractiveViewer(
      key: ValueKey('page-$n'),
      maxScale: 4,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(bytes, gaplessPlayback: true, fit: BoxFit.contain, semanticLabel: 'Page $n of $_count'),
          ),
        ),
      ),
    );
  }
}
