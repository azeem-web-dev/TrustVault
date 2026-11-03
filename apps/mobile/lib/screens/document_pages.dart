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
  final _controller = PageController();
  int _count = 0;
  int _page = 1;
  String? _error;
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
        _count = (r['pages'] as num).toInt();
        if (r['preview'] != true) _notice = r['message'] as String?;
      });
      if (_count > 0) _fetch(1);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _fetch(int n) async {
    if (_pages.containsKey(n) || _loading.contains(n) || n < 1 || n > _count) return;
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
      if (mounted) {
        setState(() => _error = e is ApiError && e.status == 404 ? 'This page is no longer available to you. Your access may have ended.' : errorText(e));
      }
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
                  padding: const EdgeInsets.fromLTRB(6, 4, 12, 4),
                  child: Row(
                    children: [
                      IconButton(onPressed: () => Navigator.pop(context), icon: Ic(PhosphorIconsBold.arrowLeft, size: 18, color: p.muted)),
                      Expanded(child: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: ts(context, size: 15, w: FontWeight.w600))),
                      if (widget.viewOnly) const TvBadge('View only', icon: PhosphorIconsDuotone.eyeSlash),
                      if (_count > 1) ...[gap8, Text('$_page / $_count', style: ts(context, size: 12, color: p.muted))],
                    ],
                  ),
                ),
                Expanded(child: _body(context, p)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: Text(
                    'Every page carries your name, the time and a trace code, and each view is recorded.',
                    textAlign: TextAlign.center,
                    style: ts(context, size: 11.5, color: p.muted),
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
    if (_error != null) return Padding(padding: const EdgeInsets.all(16), child: TvAlert(_error!));
    if (!_ready) return const Padding(padding: EdgeInsets.all(16), child: Skeleton(height: 420, radius: 14));
    if (_notice != null) return Padding(padding: const EdgeInsets.all(16), child: TvAlert(_notice!, tone: Tone.amber, title: 'No preview for this file type'));
    if (_count == 0) return const Padding(padding: EdgeInsets.all(16), child: TvAlert('This file has no pages to show.', tone: Tone.amber));
    return PageView.builder(
      controller: _controller,
      itemCount: _count,
      onPageChanged: (i) {
        setState(() => _page = i + 1);
        _fetch(i + 1);
      },
      itemBuilder: (context, i) {
        final bytes = _pages[i + 1];
        if (bytes == null) {
          _fetch(i + 1);
          return const Padding(padding: EdgeInsets.all(16), child: Skeleton(height: 420, radius: 14));
        }
        return InteractiveViewer(
          maxScale: 4,
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: ClipRRect(borderRadius: BorderRadius.circular(8), child: Image.memory(bytes, gaplessPlayback: true, fit: BoxFit.contain)),
            ),
          ),
        );
      },
    );
  }
}
