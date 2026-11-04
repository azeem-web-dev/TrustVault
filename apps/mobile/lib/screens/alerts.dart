import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/approvals.dart';
import '../widgets/ui.dart';
import 'alert_queue.dart';
import 'shell.dart';

// Severity colours, labels and icons come from severityStyle() in
// core/theme.dart, shared with the queue so they always match (R10).

PI _kindIcon(String kind) {
  if (kind.contains('malware')) return PhosphorIconsDuotone.biohazard;
  if (kind.contains('rescan')) return PhosphorIconsDuotone.bug;
  if (kind.contains('break')) return PhosphorIconsDuotone.siren;
  if (kind.contains('integrity') || kind.contains('tamper')) return PhosphorIconsDuotone.shieldWarning;
  if (kind.contains('page_view')) return PhosphorIconsDuotone.eye;
  if (kind.contains('download')) return PhosphorIconsDuotone.downloadSimple;
  if (kind.contains('share') || kind.contains('external')) return PhosphorIconsDuotone.shareNetwork;
  if (kind.contains('login') || kind.contains('sign') || kind.contains('locked')) return PhosphorIconsDuotone.lockKey;
  if (kind.contains('denied') || kind.contains('refus')) return PhosphorIconsDuotone.prohibit;
  return PhosphorIconsDuotone.bellRinging;
}

const _ranges = [('1', 'Hour'), ('24', '24 hours'), ('168', '7 days'), ('720', '30 days')];

class AlertsScreen extends StatefulWidget {
  const AlertsScreen({super.key});
  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  final _approvals = GlobalKey<ApprovalsCardState>();
  final _queue = GlobalKey<AlertQueueViewState>();
  String _tab = 'queue';
  String _hours = '24';
  List<Map>? _alerts;
  String? _error;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    try {
      final r = await Api.I.get('/admin/alerts?hours=$_hours') as Map;
      if (mounted && gen == _gen) {
        setState(() {
          _alerts = (r['alerts'] as List).cast<Map>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = errorText(e));
    }
  }

  /// Pull to refresh: the visible tab and the approvals card, keeping the
  /// queue's filters; the spinner stays until both have loaded (R10).
  Future<void> _refresh() async {
    await Future.wait([
      if (_tab == 'queue') _queue.currentState?.reload() ?? Future<void>.value() else _load(),
      _approvals.currentState?.load() ?? Future<void>.value(),
    ]);
  }

  String _count(String s) => _alerts == null ? '–' : '${_alerts!.where((a) => a['severity'] == s).length}';

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final a = _alerts;
    return PageBody(
      onRefresh: _refresh,
      children: [
        const PageTitle(
          title: 'Alerts',
          icon: PhosphorIconsDuotone.bellRinging,
          subtitle: 'Every alert is kept: the queue shows all of them, highest severity first, with who acknowledged, assigned and resolved each one.',
        ),
        Segmented<String>(
          value: _tab,
          expand: true,
          onChanged: (t) => setState(() => _tab = t),
          options: const [SegOption('queue', 'Queue'), SegOption('live', 'Live view')],
        ),
        gap16,
        // Tab change fades the new view in (§2.3); the queue keeps its
        // GlobalKey so pull to refresh can reach it.
        Rise(
          key: ValueKey('tab-$_tab'),
          dy: 6,
          child: _tab == 'queue'
              ? AlertQueueView(key: _queue)
              : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: _live(context, p, a)),
        ),
        gap16,
        ApprovalsCard(key: _approvals),
        gap16,
        _BreakGlass(onDone: () {
          _load();
          _approvals.currentState?.load();
        }),
      ],
    );
  }

  List<Widget> _live(BuildContext context, Pal p, List<Map>? a) {
    return [
      Segmented<String>(
        value: _hours,
        expand: true,
        onChanged: (h) {
          setState(() {
            _hours = h;
            _alerts = null;
          });
          _load();
        },
        options: [for (final (id, label) in _ranges) SegOption(id, label)],
      ),
      gap16,
      StatGrid(
        children: [
          StatCard(label: 'Critical', value: _count('critical'), icon: PhosphorIconsDuotone.warningOctagon, tone: severityStyle('critical').tone, hint: 'Act now'),
          StatCard(label: 'High', value: _count('high'), icon: PhosphorIconsDuotone.warning, tone: severityStyle('high').tone, hint: 'Look today', delay: 60),
          StatCard(label: 'Medium', value: _count('medium'), icon: PhosphorIconsDuotone.fire, tone: severityStyle('medium').tone, hint: 'Worth a check', delay: 120),
          StatCard(label: 'Info', value: _count('info'), icon: PhosphorIconsDuotone.info, tone: severityStyle('info').tone, hint: 'For the record', delay: 180),
        ],
      ),
      gap16,
      if (_error != null && a != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
      TvCard(
        title: 'What to notice',
        icon: PhosphorIconsDuotone.bellRinging,
        description: 'Last ${_ranges.firstWhere((r) => r.$1 == _hours).$2.toLowerCase()}',
        padded: false,
        child: fadeSwap(
          context,
          a == null ? (_error != null ? 'error' : 'loading') : (a.isEmpty ? 'empty' : 'list-$_hours'),
          a == null
              ? (_error != null ? ErrorState(title: 'Could not load alerts', message: _error, onRetry: _load) : const SkeletonRows(rows: 4))
              : a.isEmpty
              ? const EmptyState(icon: PhosphorIconsDuotone.shieldCheck, tone: Tone.green, title: 'All clear', body: 'Nothing unusual in this period.')
              : RowList(
                  children: [for (var i = 0; i < a.length; i++) Rise(delay: (i < 8 ? i : 8) * 40, child: _alertRow(context, p, a[i]))],
                ),
        ),
      ),
    ];
  }

  Widget _alertRow(BuildContext context, Pal p, Map a) {
    final kind = a['kind'] as String;
    final k = kind.replaceAll('_', ' ');
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SeverityBar(a['severity'] as String?),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 14, 14, 14),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(color: p.soft2, borderRadius: BorderRadius.circular(12)),
                    child: Center(child: Ic(_kindIcon(kind), size: 20, color: p.body)),
                  ),
                  gap12,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(a['message'] as String, style: ts(context, size: 13.5, w: FontWeight.w500, height: 1.45)),
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: 6,
                          runSpacing: 2,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(k.isEmpty ? k : k[0].toUpperCase() + k.substring(1), style: ts(context, size: 12, color: p.muted)),
                            if (a['at'] != null) Text('· ${relativeTime(a['at'] as String?)}', style: ts(context, size: 12, color: p.muted)),
                            if (a['documentTitle'] != null || a['documentId'] != null)
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text('· ', style: ts(context, size: 12, color: p.muted)),
                                  Ic(PhosphorIconsDuotone.fileText, size: 13, color: p.accent),
                                  const SizedBox(width: 3),
                                  Text(
                                    '${a['documentTitle'] ?? a['documentId']}',
                                    style: ts(context, size: 12, w: FontWeight.w600, color: p.accent),
                                  ),
                                ],
                              ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        SeverityPill(a['severity'] as String?),
                      ],
                    ),
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

class _BreakGlass extends StatefulWidget {
  const _BreakGlass({required this.onDone});
  final VoidCallback onDone;
  @override
  State<_BreakGlass> createState() => _BreakGlassState();
}

class _BreakGlassState extends State<_BreakGlass> {
  final _doc = TextEditingController();
  final _reason = TextEditingController();
  bool _asked = false;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reason.addListener(_changed);
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    _reason.removeListener(_changed);
    _reason.dispose();
    _doc.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (_doc.text.trim().isEmpty || _reason.text.trim().length < 20) {
      setState(() => _error = 'Give the document id and a reason of at least 20 characters.');
      return;
    }
    setState(() {
      _error = null;
      _busy = true;
    });
    try {
      // Break-glass needs a second administrator (THREATS.md S19): this asks.
      await Api.I.post('/admin/approvals', {'action': 'BREAK_GLASS', 'documentId': _doc.text.trim(), 'reason': _reason.text});
      if (!mounted) return;
      setState(() {
        _asked = true;
        _reason.clear();
      });
      toast(context, 'Request sent. Another administrator must approve it.', tone: Tone.blue);
      widget.onDone();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final amber = toneOf(Tone.amber, p.dark);
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: amber.ring),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [amber.bg, p.card, p.card],
        ),
        boxShadow: p.shadow,
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: 6, child: CustomPaint(painter: _Stripes(dark: p.dark))),
          Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 46,
                      height: 46,
                      decoration: BoxDecoration(
                        color: amber.dot,
                        borderRadius: BorderRadius.circular(14),
                        boxShadow: [BoxShadow(color: amber.dot.withValues(alpha: .4), blurRadius: 14, offset: const Offset(0, 6), spreadRadius: -4)],
                      ),
                      child: Center(child: Ic(PhosphorIconsDuotone.siren, size: 22, color: severityStyle('medium').fg)),
                    ),
                    gap12,
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Break-glass access', style: ts(context, size: 15, w: FontWeight.w600)),
                          const SizedBox(height: 4),
                          const TvBadge('Audited and alerted', tone: Tone.amber, icon: PhosphorIconsDuotone.listMagnifyingGlass),
                        ],
                      ),
                    ),
                  ],
                ),
                gap12,
                Text(
                  "Administrators cannot open documents. In an emergency (legal hold, incident response) you can ask for one hour of view-only access to a single document: its pages, watermarked with your name, never the original file. A second administrator must approve; then you open it from the requests above, once, within 24 hours. The owner is emailed when it is approved, and the reason is in the audit trail, the alerts and the document's history. With only one administrator it is impossible.",
                  style: ts(context, size: 13, color: p.body, height: 1.55),
                ),
                gap16,
                FieldLabel(
                  'Document id',
                  child: TextField(
                    controller: _doc,
                    decoration: fieldDeco(hint: 'from the audit log', icon: PhosphorIconsDuotone.fileText),
                  ),
                ),
                gap12,
                FieldLabel(
                  'Reason (at least 20 characters)',
                  hint: _reason.text.trim().length < 20 ? '${_reason.text.length}/500 · ${20 - _reason.text.trim().length} more needed' : '${_reason.text.length}/500',
                  child: TextField(
                    controller: _reason,
                    maxLines: 3,
                    maxLength: 500,
                    decoration: fieldDeco(hint: 'e.g. Legal hold requested by counsel, ticket LEG-142').copyWith(counterText: ''),
                  ),
                ),
                gap16,
                Btn('Ask for emergency access', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.siren, loading: _busy, expand: true, onPressed: _submit),
                if (_error != null) ...[gap12, Rise(dy: 6, child: TvAlert(_error!))],
                if (_asked) ...[
                  gap12,
                  const Rise(dy: 6, child: TvAlert('Once another admin approves, open the access from "Requests waiting for approval" above.', tone: Tone.amber, title: 'Waiting for a second administrator')),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The hazard stripe (the web's `.hazard-stripe`): amber on slate, from the
/// palette rather than a raw hex value.
class _Stripes extends CustomPainter {
  const _Stripes({required this.dark});
  final bool dark;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    final amber = Paint()..color = C.amber500.withValues(alpha: .85);
    final dark = Paint()..color = (this.dark ? C.slate900 : C.slate800).withValues(alpha: .85);
    const w = 12.0;
    var i = 0;
    for (double x = -size.height; x < size.width + size.height; x += w) {
      final path = Path()
        ..moveTo(x, size.height)
        ..lineTo(x + size.height, 0)
        ..lineTo(x + size.height + w, 0)
        ..lineTo(x + w, size.height)
        ..close();
      canvas.drawPath(path, i.isEven ? amber : dark);
      i++;
    }
  }

  @override
  bool shouldRepaint(covariant _Stripes oldDelegate) => oldDelegate.dark != dark;
}
