import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/ui.dart';
import 'alert_queue.dart';
import 'document_detail.dart';
import 'shell.dart';

class _Sev {
  const _Sev(this.label, this.color, this.fg, this.icon);
  final String label;
  final Color color;
  final Color fg;
  final PI icon;
}

final _sev = {
  'critical': _Sev('Critical', C.red600, Colors.white, PhosphorIconsFill.warningOctagon),
  'high': _Sev('High', C.orange500, Colors.white, PhosphorIconsFill.warning),
  'medium': _Sev('Medium', C.amber400, C.amber950, PhosphorIconsRegular.warning),
  'info': _Sev('Info', C.sky500, Colors.white, PhosphorIconsFill.info),
};

PI _kindIcon(String kind) {
  if (kind.contains('malware')) return PhosphorIconsDuotone.biohazard;
  if (kind.contains('rescan')) return PhosphorIconsDuotone.bug;
  if (kind.contains('break')) return PhosphorIconsDuotone.siren;
  if (kind.contains('integrity') || kind.contains('tamper')) return PhosphorIconsDuotone.shieldWarning;
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
  String _tab = 'queue';
  Key _queueKey = UniqueKey();
  String _hours = '24';
  List<Map>? _alerts;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/admin/alerts?hours=$_hours') as Map;
      if (mounted) setState(() => _alerts = (r['alerts'] as List).cast<Map>());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  String _count(String s) => _alerts == null ? '–' : '${_alerts!.where((a) => a['severity'] == s).length}';

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final a = _alerts;
    return PageBody(
      onRefresh: () async {
        if (_tab == 'queue') {
          setState(() => _queueKey = UniqueKey());
        } else {
          await _load();
        }
      },
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
        if (_tab == 'queue') AlertQueueView(key: _queueKey),
        if (_tab == 'live') ..._live(context, p, a),
        gap16,
        _BreakGlass(onDone: _load),
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
          StatCard(label: 'Critical', value: _count('critical'), icon: PhosphorIconsDuotone.warningOctagon, tone: Tone.red, hint: 'Act now'),
          StatCard(label: 'High', value: _count('high'), icon: PhosphorIconsDuotone.warning, tone: Tone.amber, hint: 'Look today', delay: 60),
          StatCard(label: 'Medium', value: _count('medium'), icon: PhosphorIconsDuotone.fire, tone: Tone.violet, hint: 'Worth a check', delay: 120),
          StatCard(label: 'Info', value: _count('info'), icon: PhosphorIconsDuotone.info, tone: Tone.blue, hint: 'For the record', delay: 180),
        ],
      ),
      gap16,
      if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
      TvCard(
        title: 'What to notice',
        icon: PhosphorIconsDuotone.bellRinging,
        description: 'Last ${_ranges.firstWhere((r) => r.$1 == _hours).$2.toLowerCase()}',
        padded: false,
        child: a == null
            ? const SkeletonRows(rows: 4)
            : a.isEmpty
            ? const EmptyState(icon: PhosphorIconsDuotone.shieldCheck, tone: Tone.green, title: 'All clear', body: 'Nothing unusual in this period.')
            : RowList(
                children: [for (var i = 0; i < a.length; i++) Rise(delay: i * 30, child: _alertRow(context, p, a[i]))],
              ),
      ),
    ];
  }

  Widget _alertRow(BuildContext context, Pal p, Map a) {
    final s = _sev[a['severity']] ?? _sev['info']!;
    final kind = a['kind'] as String;
    final k = kind.replaceAll('_', ' ');
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 4,
            margin: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: s.color,
              borderRadius: const BorderRadius.horizontal(right: Radius.circular(4)),
            ),
          ),
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
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                          decoration: BoxDecoration(color: s.color, borderRadius: BorderRadius.circular(99)),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Ic(s.icon, size: 13, color: s.fg),
                              const SizedBox(width: 4),
                              Text(
                                s.label.toUpperCase(),
                                style: TextStyle(color: s.fg, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: .6),
                              ),
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
  Map? _result;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _reason.addListener(() => setState(() {}));
  }

  Future<void> _submit() async {
    if (_doc.text.trim().isEmpty || _reason.text.trim().length < 20) {
      setState(() => _error = 'Give the document id and a reason of at least 20 characters.');
      return;
    }
    setState(() {
      _error = null;
      _busy = true;
    });
    try {
      final r = await Api.I.post('/admin/break-glass', {'documentId': _doc.text.trim(), 'reason': _reason.text}) as Map;
      if (!mounted) return;
      setState(() {
        _result = r;
        _reason.clear();
      });
      toast(context, 'Emergency access granted for one hour. This was alerted.', tone: Tone.blue);
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
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: p.dark ? C.amber500.withValues(alpha: .3) : C.amber300.withValues(alpha: .7)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [p.dark ? C.amber500.withValues(alpha: .10) : C.amber50, p.card, p.card],
        ),
        boxShadow: p.shadow,
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: 6, child: CustomPaint(painter: _Stripes())),
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
                        color: C.amber500,
                        borderRadius: BorderRadius.circular(14),
                        boxShadow: [BoxShadow(color: C.amber500.withValues(alpha: .4), blurRadius: 14, offset: const Offset(0, 6))],
                      ),
                      child: const Center(child: Ic(PhosphorIconsDuotone.siren, size: 24, color: Colors.white)),
                    ),
                    gap12,
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Break-glass access', style: ts(context, size: 15, w: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                            decoration: BoxDecoration(color: p.dark ? C.amber500.withValues(alpha: .2) : C.amber100, borderRadius: BorderRadius.circular(99)),
                            child: Text(
                              'Audited and alerted',
                              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: p.dark ? C.amber200 : C.amber800),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                gap12,
                Text(
                  "Administrators cannot open documents. In an emergency (legal hold, incident response) you can take one hour of read access to a single document. The reason is recorded in the audit trail, raised as an alert, and shown in the document's own history to its owner.",
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
                  hint: '${_reason.text.length}/500',
                  child: TextField(
                    controller: _reason,
                    maxLines: 3,
                    maxLength: 500,
                    decoration: fieldDeco(hint: 'e.g. Legal hold requested by counsel, ticket LEG-142').copyWith(counterText: ''),
                  ),
                ),
                gap16,
                Btn('Take emergency access', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.siren, loading: _busy, expand: true, onPressed: _submit),
                if (_error != null) ...[gap12, TvAlert(_error!)],
                if (_result != null) ...[
                  gap12,
                  TvAlert(
                    'Access to "${_result!['title']}" until ${formatDate(_result!['expiresAt'] as String?)}.',
                    tone: Tone.amber,
                    title: 'Emergency access granted',
                    action: Btn(
                      'Open document',
                      size: BtnSize.sm,
                      icon: PhosphorIconsDuotone.arrowSquareOut,
                      onPressed: () =>
                          Navigator.of(context).push(MaterialPageRoute(builder: (_) => DocumentDetailScreen(id: _result!['documentId'] as String))),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Stripes extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    final amber = Paint()..color = C.amber500.withValues(alpha: .85);
    final dark = Paint()..color = const Color(0xFF1F2937).withValues(alpha: .85);
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
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
