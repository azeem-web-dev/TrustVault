import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/phosphor.dart';
import '../widgets/ui.dart';

/// The persistent alert queue (same API as the web page): every alert,
/// highest severity first, filterable, with acknowledge / assign / resolve
/// and the full review history. Every step is audited on the server.

class _Sev {
  const _Sev(this.label, this.color, this.fg);
  final String label;
  final Color color;
  final Color fg;
}

final _sev = {
  'critical': _Sev('Critical', C.red600, Colors.white),
  'high': _Sev('High', C.orange500, Colors.white),
  'medium': _Sev('Medium', C.amber400, C.amber950),
  'low': _Sev('Low', C.sky500, Colors.white),
  'info': _Sev('Info', const Color(0xFF94A3B8), Colors.white),
};

const _statusTone = {'open': Tone.red, 'acknowledged': Tone.amber, 'assigned': Tone.blue, 'resolved': Tone.green};
const _resolutions = [
  ('true_positive', 'True positive: it happened'),
  ('false_positive', 'False positive: the rule was wrong'),
  ('benign', 'Benign: real, but legitimate'),
  ('duplicate', 'Duplicate of another alert'),
];

String _human(String s) => s.replaceAll('_', ' ');

class AlertQueueView extends StatefulWidget {
  const AlertQueueView({super.key});
  @override
  State<AlertQueueView> createState() => _AlertQueueViewState();
}

class _AlertQueueViewState extends State<AlertQueueView> {
  String _status = 'active';
  String _minSeverity = '';
  final _subject = TextEditingController();
  List<Map>? _alerts;
  Map? _summary;
  int _total = 0;
  String? _cursor;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String _query([String? after]) {
    final q = <String, String>{'status': _status, 'limit': '30'};
    if (_minSeverity.isNotEmpty) q['minSeverity'] = _minSeverity;
    if (_subject.text.trim().isNotEmpty) q['subject'] = _subject.text.trim();
    if (after != null) q['cursor'] = after;
    return '/admin/alert-queue?${Uri(queryParameters: q).query}';
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final s = await Api.I.get('/admin/alert-queue/summary') as Map;
      final r = await Api.I.get(_query()) as Map;
      if (!mounted) return;
      setState(() {
        _summary = s;
        _alerts = (r['alerts'] as List).cast<Map>();
        _total = r['total'] as int;
        _cursor = r['nextCursor'] as String?;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _more() async {
    if (_cursor == null) return;
    setState(() => _busy = true);
    try {
      final r = await Api.I.get(_query(_cursor)) as Map;
      if (!mounted) return;
      setState(() {
        _alerts = [...?_alerts, ...(r['alerts'] as List).cast<Map>()];
        _cursor = r['nextCursor'] as String?;
      });
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _n(String s) => _summary == null ? '–' : '${(_summary!['unresolvedBySeverity'] as Map)[s] ?? 0}';

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final a = _alerts;
    final gen = _summary?['generator'] as Map?;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        StatGrid(
          children: [
            StatCard(label: 'Critical', value: _n('critical'), icon: PhosphorIconsDuotone.warningOctagon, tone: Tone.red, hint: 'Unresolved'),
            StatCard(label: 'High', value: _n('high'), icon: PhosphorIconsDuotone.warning, tone: Tone.amber, hint: 'Unresolved', delay: 60),
            StatCard(label: 'Medium', value: _n('medium'), icon: PhosphorIconsDuotone.fire, tone: Tone.violet, hint: 'Unresolved', delay: 120),
            StatCard(
              label: 'Low + info',
              value: _summary == null
                  ? '–'
                  : '${((_summary!['unresolvedBySeverity'] as Map)['low'] ?? 0) + ((_summary!['unresolvedBySeverity'] as Map)['info'] ?? 0)}',
              icon: PhosphorIconsDuotone.info,
              tone: Tone.blue,
              hint: 'Unresolved',
              delay: 180,
            ),
          ],
        ),
        gap16,
        if (gen != null && gen['stale'] == true) ...[
          TvAlert(
            'Last good run ${relativeTime(gen['lastOkAt'] as String?)}. Nothing is lost: the next run reads from where the last good one stopped.',
            tone: Tone.amber,
            title: 'Alert rules have not run recently',
          ),
          gap12,
        ],
        if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        TvCard(
          title: 'Alert queue',
          icon: PhosphorIconsDuotone.listMagnifyingGlass,
          description: a == null ? 'Loading' : '${a.length} of $_total · highest severity first',
          padded: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _status,
                            decoration: fieldDeco(),
                            items: const [
                              DropdownMenuItem(value: 'active', child: Text('Not resolved')),
                              DropdownMenuItem(value: 'open', child: Text('Open')),
                              DropdownMenuItem(value: 'acknowledged', child: Text('Acknowledged')),
                              DropdownMenuItem(value: 'assigned', child: Text('Assigned')),
                              DropdownMenuItem(value: 'resolved', child: Text('Resolved')),
                              DropdownMenuItem(value: 'all', child: Text('All')),
                            ],
                            onChanged: (v) {
                              setState(() => _status = v ?? 'active');
                              _load();
                            },
                          ),
                        ),
                        gap12,
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _minSeverity,
                            decoration: fieldDeco(),
                            items: const [
                              DropdownMenuItem(value: '', child: Text('Any severity')),
                              DropdownMenuItem(value: 'critical', child: Text('Critical')),
                              DropdownMenuItem(value: 'high', child: Text('High or more')),
                              DropdownMenuItem(value: 'medium', child: Text('Medium or more')),
                              DropdownMenuItem(value: 'low', child: Text('Low or more')),
                            ],
                            onChanged: (v) {
                              setState(() => _minSeverity = v ?? '');
                              _load();
                            },
                          ),
                        ),
                      ],
                    ),
                    gap12,
                    TextField(
                      controller: _subject,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.search,
                      onSubmitted: (_) => _load(),
                      decoration: fieldDeco(hint: 'Person (email)', icon: PhosphorIconsDuotone.magnifyingGlass),
                    ),
                  ],
                ),
              ),
              if (a == null)
                const SkeletonRows(rows: 4)
              else if (a.isEmpty)
                const EmptyState(icon: PhosphorIconsDuotone.shieldCheck, tone: Tone.green, title: 'Nothing here', body: 'No alerts match these filters.')
              else
                RowList(children: [for (final x in a) _row(context, p, x)]),
              if (_cursor != null)
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Btn('Load more', loading: _busy, expand: true, onPressed: _more),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, Pal p, Map a) {
    final s = _sev[a['severity']] ?? _sev['info']!;
    final status = a['status'] as String;
    return InkWell(
      onTap: () async {
        await showAlertDetail(context, a['id'] as String);
        _load();
      },
      child: IntrinsicHeight(
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
                padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(a['message'] as String, style: ts(context, size: 13.5, w: FontWeight.w500, height: 1.45)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(color: s.color, borderRadius: BorderRadius.circular(99)),
                          child: Text(
                            s.label.toUpperCase(),
                            style: TextStyle(color: s.fg, fontSize: 10, fontWeight: FontWeight.w700, letterSpacing: .5),
                          ),
                        ),
                        TvBadge(status, tone: _statusTone[status] ?? Tone.neutral, dot: true),
                        Text('${_human(a['rule'] as String)} · ${relativeTime(a['createdAt'] as String?)}', style: ts(context, size: 12, color: p.muted)),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<void> showAlertDetail(BuildContext context, String id) {
  return showSheet<void>(
    context,
    title: 'Alert',
    icon: PhosphorIconsDuotone.bellRinging,
    builder: (ctx) => _AlertDetail(id: id),
  );
}

class _AlertDetail extends StatefulWidget {
  const _AlertDetail({required this.id});
  final String id;
  @override
  State<_AlertDetail> createState() => _AlertDetailState();
}

class _AlertDetailState extends State<_AlertDetail> {
  Map? _data;
  List<Map> _reviewers = [];
  final _note = TextEditingController();
  String? _assignee;
  String _resolution = 'true_positive';
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _note.addListener(() => setState(() {}));
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await Api.I.get('/admin/alert-queue/${widget.id}') as Map;
      final r = await Api.I.get('/admin/alert-queue/reviewers') as Map;
      if (mounted) {
        setState(() {
          _data = d;
          _reviewers = (r['reviewers'] as List).cast<Map>();
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _act(String action, Map<String, dynamic> body) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.I.post('/admin/alert-queue/${widget.id}/$action', body);
      if (!mounted) return;
      toast(
        context,
        const {'acknowledge': 'Acknowledged', 'assign': 'Assigned', 'resolve': 'Resolved', 'reopen': 'Reopened', 'comment': 'Comment added'}[action] ?? 'Saved',
      );
      _note.clear();
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final d = _data;
    if (d == null) return _error != null ? TvAlert(_error!) : const SkeletonRows(rows: 3);
    final a = d['alert'] as Map;
    final history = (d['history'] as List).cast<Map>();
    final status = a['status'] as String;
    final resolved = status == 'resolved';
    final note = _note.text.trim();
    final s = _sev[a['severity']] ?? _sev['info']!;
    Widget kv(String k, String v) => Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$k  ',
              style: ts(context, size: 12, color: p.muted),
            ),
            TextSpan(text: v, style: ts(context, size: 12.5)),
          ],
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(a['message'] as String, style: ts(context, size: 14, w: FontWeight.w500, height: 1.45)),
        gap12,
        kv('Severity', '${s.label} · ${a['category']} · ${_human(a['rule'] as String)}'),
        kv('Raised', formatDate(a['createdAt'] as String?)),
        kv('Status', '$status${a['resolution'] != null ? ' (${_human(a['resolution'] as String)})' : ''}'),
        if (a['subjectEmail'] != null) kv('Person', a['subjectEmail'] as String),
        if (a['assigneeEmail'] != null) kv('Assigned to', a['assigneeEmail'] as String),
        if (a['observed'] != null) kv('Observed / threshold', '${a['observed']}${a['threshold'] != null ? ' / ${a['threshold']}' : ''}'),
        kv('Same person, 30 days', '${d['relatedAlerts30d']} other alerts'),
        gap16,
        Text('History', style: ts(context, size: 14, w: FontWeight.w600)),
        const SizedBox(height: 6),
        if (history.isEmpty) Text('No review steps yet.', style: ts(context, size: 12.5, color: p.muted)),
        for (final h in history)
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: p.soft2, borderRadius: BorderRadius.circular(12)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${h['action']} → ${h['statusAfter']} · ${h['actorEmail'] ?? 'system'} · ${formatDate(h['at'] as String?)}${h['action'] == 'assign' && h['assigneeEmail'] != null ? ' · to ${h['assigneeEmail']}' : ''}${h['resolution'] != null ? ' · ${_human(h['resolution'] as String)}' : ''}',
                  style: ts(context, size: 12),
                ),
                if (h['note'] != null) Text('“${h['note']}”', style: ts(context, size: 12, color: p.body)),
              ],
            ),
          ),
        gap16,
        FieldLabel(
          'Note',
          hint: 'Recorded in the history and the audit log',
          child: TextField(
            controller: _note,
            maxLines: 2,
            maxLength: 2000,
            decoration: fieldDeco(hint: 'What you checked, what you found').copyWith(counterText: ''),
          ),
        ),
        gap12,
        if (status == 'open') ...[
          Btn(
            'Acknowledge',
            icon: PhosphorIconsDuotone.checkCircle,
            loading: _busy,
            expand: true,
            onPressed: () => _act('acknowledge', note.isEmpty ? {} : {'note': note}),
          ),
          gap12,
        ],
        if (!resolved) ...[
          DropdownButtonFormField<String>(
            initialValue: _assignee,
            decoration: fieldDeco(hint: 'Assign to…'),
            items: [
              for (final r in _reviewers.where((r) => r['id'] != a['subjectUserId']))
                DropdownMenuItem(value: r['id'] as String, child: Text(r['email'] as String)),
            ],
            onChanged: (v) => setState(() => _assignee = v),
          ),
          gap12,
          Btn(
            'Assign',
            icon: PhosphorIconsDuotone.userPlus,
            loading: _busy,
            expand: true,
            onPressed: _assignee == null ? null : () => _act('assign', {'assigneeId': _assignee, if (note.isNotEmpty) 'note': note}),
          ),
          gap12,
          DropdownButtonFormField<String>(
            initialValue: _resolution,
            decoration: fieldDeco(),
            items: [for (final (id, label) in _resolutions) DropdownMenuItem(value: id, child: Text(label))],
            onChanged: (v) => setState(() => _resolution = v ?? 'true_positive'),
          ),
          gap12,
          Btn(
            'Resolve',
            variant: BtnVariant.primary,
            icon: PhosphorIconsDuotone.sealCheck,
            loading: _busy,
            expand: true,
            onPressed: note.length < 5 ? null : () => _act('resolve', {'resolution': _resolution, 'note': note}),
          ),
        ],
        if (resolved)
          Btn(
            'Reopen',
            icon: PhosphorIconsDuotone.arrowCounterClockwise,
            loading: _busy,
            expand: true,
            onPressed: note.length < 5 ? null : () => _act('reopen', {'note': note}),
          ),
        gap12,
        Btn(
          'Comment',
          variant: BtnVariant.ghost,
          icon: PhosphorIconsDuotone.pencilSimple,
          loading: _busy,
          expand: true,
          onPressed: note.length < 5 ? null : () => _act('comment', {'note': note}),
        ),
        if (_error != null) ...[gap12, TvAlert(_error!)],
        gap12,
        Text('Resolving needs a note. An alert about you must be resolved by another administrator.', style: ts(context, size: 11.5, color: p.muted)),
      ],
    );
  }
}
