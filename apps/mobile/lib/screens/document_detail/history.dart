part of '../document_detail.dart';

/* ---------------------------------------------------------------- history */

class _History extends StatefulWidget {
  const _History({required this.docId});
  final String docId;
  @override
  State<_History> createState() => _HistoryState();
}

class _HistoryState extends State<_History> {
  List<Map>? _events;
  /// A failed load says so: on a security screen an error must never read
  /// as "nothing happened".
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/${widget.docId}/history') as Map;
      if (mounted) {
        setState(() {
          _events = (r['events'] as List).cast<Map>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not load the history.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final ev = _events;
    return TvCard(
      title: 'History',
      icon: PhosphorIconsDuotone.clockCounterClockwise,
      description: 'Everything that happened to this document, including refused attempts.',
      padded: ev == null || ev.isEmpty ? false : true,
      child: ev == null && _error != null
          ? ErrorState(title: 'Could not load the history', message: _error, onRetry: _load)
          : ev == null
          ? const SkeletonRows(rows: 5)
          : ev.isEmpty
          ? const EmptyState(icon: PhosphorIconsDuotone.clockCounterClockwise, title: 'No activity yet', body: 'Views, downloads, shares and refused attempts will show here.')
          : Column(
              children: [
                for (var i = 0; i < ev.length; i++)
                  Rise(
                    key: ValueKey('e-${ev[i]['seq']}'),
                    delay: 40 * i.clamp(0, 8),
                    dy: 6,
                    child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Column(
                          children: [
                            ActionIcon(ev[i]['action'] as String, ev[i]['outcome'] as String),
                            if (i < ev.length - 1)
                              Expanded(
                                child: Container(width: 1.2, margin: const EdgeInsets.symmetric(vertical: 4), color: p.border),
                              ),
                          ],
                        ),
                        gap12,
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(bottom: 16, top: 2),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Wrap(
                                  spacing: 6,
                                  crossAxisAlignment: WrapCrossAlignment.center,
                                  children: [
                                    Text(actionMeta(ev[i]['action'] as String).label, style: ts(context, size: 13.5, w: FontWeight.w600)),
                                    if (ev[i]['outcome'] != 'ALLOWED') TvBadge(outcomeLabel(ev[i]['outcome'] as String), tone: outcomeTone[ev[i]['outcome']] ?? Tone.neutral),
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  '${ev[i]['actorEmail'] ?? 'system'} · ${relativeTime(ev[i]['occurredAt'] as String?)}${ev[i]['reason'] != null ? ' · ${(ev[i]['reason'] as String).replaceAll('_', ' ')}' : ''}',
                                  style: ts(context, size: 12, color: p.muted),
                                ),
                                if (_sanitizedFrom(ev[i]['details']) case final note?)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 2),
                                    child: Text(note, style: ts(context, size: 12, color: p.muted, height: 1.4)),
                                  ),
                              ],
                            ),
                          ),
                        ),
                        Text(
                          '#${ev[i]['seq']}',
                          style: TextStyle(fontFamily: C.mono, fontSize: 11, color: p.subtle),
                        ),
                      ],
                    ),
                  ),
                  ),
              ],
            ),
    );
  }
}
