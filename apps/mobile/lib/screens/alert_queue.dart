import 'package:flutter/material.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/phosphor.dart';
import '../widgets/ui.dart';

/// The persistent alert queue (same API as the web page): every alert,
/// highest severity first, filterable, with acknowledge / assign / resolve
/// and the full review history. Every step is audited on the server.

// Severity colours and status labels come from core/theme.dart
// (severityStyle, statusLabel, statusTone), shared with the live view (R10).

const _resolutions = [
  ('true_positive', 'True positive: it happened'),
  ('false_positive', 'False positive: the rule was wrong'),
  ('benign', 'Benign: real, but legitimate'),
  ('duplicate', 'Duplicate of another alert'),
];

String _human(String s) => s.replaceAll('_', ' ');

/// Past-tense label for a review step in the history.
const _actionLabel = {'acknowledge': 'Acknowledged', 'assign': 'Assigned', 'resolve': 'Resolved', 'reopen': 'Reopened', 'comment': 'Commented', 'create': 'Raised'};

/// Icon and tone for a review step, the same icons as the action buttons.
const _actionIcon = {
  'acknowledge': (PhosphorIconsDuotone.checkCircle, Tone.amber),
  'assign': (PhosphorIconsDuotone.userPlus, Tone.blue),
  'resolve': (PhosphorIconsDuotone.sealCheck, Tone.green),
  'reopen': (PhosphorIconsDuotone.arrowCounterClockwise, Tone.red),
  'comment': (PhosphorIconsDuotone.pencilSimple, Tone.neutral),
  'create': (PhosphorIconsDuotone.bellRinging, Tone.brand),
};

/// Solid severity pill (critical red … info slate), shared by the queue and
/// the live view so both draw the same marker (§2.1).
class SeverityPill extends StatelessWidget {
  const SeverityPill(this.severity, {super.key});
  final String? severity;
  @override
  Widget build(BuildContext context) {
    final s = severityStyle(severity);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: s.color, borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Ic(s.icon, size: 11, color: s.fg),
          const SizedBox(width: 4),
          Text(
            s.label.toUpperCase(),
            style: TextStyle(color: s.fg, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: .5),
          ),
        ],
      ),
    );
  }
}

/// The coloured bar on the left of an alert row.
class SeverityBar extends StatelessWidget {
  const SeverityBar(this.severity, {super.key});
  final String? severity;
  @override
  Widget build(BuildContext context) => Container(
    width: 4,
    margin: const EdgeInsets.symmetric(vertical: 10),
    decoration: BoxDecoration(
      color: severityStyle(severity).color,
      borderRadius: const BorderRadius.horizontal(right: Radius.circular(4)),
    ),
  );
}

/// Cross-fades loading → content → empty (skeleton → content, §2.3);
/// instant under reduced motion.
Widget fadeSwap(BuildContext context, Object state, Widget child) => AnimatedSwitcher(
  duration: Motion.of(context),
  switchInCurve: Motion.curve,
  switchOutCurve: Motion.easeIn,
  layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
  child: KeyedSubtree(key: ValueKey(state), child: child),
);

class AlertQueueView extends StatefulWidget {
  const AlertQueueView({super.key});
  @override
  State<AlertQueueView> createState() => AlertQueueViewState();
}

class AlertQueueViewState extends State<AlertQueueView> {
  String _status = 'active';
  String _minSeverity = '';
  final _subject = TextEditingController();
  List<Map>? _alerts;
  Map? _summary;
  int _total = 0;
  String? _cursor;
  String? _error;

  /// "Load more" is running.
  bool _loadingMore = false;

  /// Bumped by every filter change or reload; answers for an older one are
  /// dropped (R9).
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _subject.dispose();
    super.dispose();
  }

  /// Reloads the first page with the current filters (pull to refresh).
  Future<void> reload() => _load();

  /// A filter changed: show the skeleton, not the old list, while it loads.
  void _refilter(VoidCallback change) {
    setState(() {
      change();
      _alerts = null;
      _cursor = null;
      _loadingMore = false;
    });
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
    final gen = ++_gen;
    try {
      // Summary and list in parallel (R9).
      final res = await Future.wait([Api.I.get('/admin/alert-queue/summary'), Api.I.get(_query())]);
      if (!mounted || gen != _gen) return;
      final r = res[1] as Map;
      setState(() {
        _summary = res[0] as Map;
        _alerts = (r['alerts'] as List).cast<Map>();
        _total = r['total'] as int;
        _cursor = r['nextCursor'] as String?;
        _loadingMore = false;
        _error = null;
      });
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = errorText(e));
    }
  }

  Future<void> _more() async {
    final cursor = _cursor;
    if (cursor == null || _loadingMore || _alerts == null) return;
    final gen = _gen;
    setState(() => _loadingMore = true);
    try {
      final r = await Api.I.get(_query(cursor)) as Map;
      // A filter change or reload since then: this page belongs to the old list.
      if (!mounted || gen != _gen) return;
      setState(() {
        final seen = {for (final x in _alerts!) x['id']};
        _alerts = [..._alerts!, ...(r['alerts'] as List).cast<Map>().where((x) => !seen.contains(x['id']))];
        _cursor = r['nextCursor'] as String?;
      });
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = errorText(e));
    } finally {
      if (mounted && gen == _gen) setState(() => _loadingMore = false);
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
            StatCard(label: 'Critical', value: _n('critical'), icon: PhosphorIconsDuotone.warningOctagon, tone: severityStyle('critical').tone, hint: 'Unresolved'),
            StatCard(label: 'High', value: _n('high'), icon: PhosphorIconsDuotone.warning, tone: severityStyle('high').tone, hint: 'Unresolved', delay: 60),
            StatCard(label: 'Medium', value: _n('medium'), icon: PhosphorIconsDuotone.fire, tone: severityStyle('medium').tone, hint: 'Unresolved', delay: 120),
            StatCard(
              label: 'Low + info',
              value: _summary == null
                  ? '–'
                  : '${((_summary!['unresolvedBySeverity'] as Map)['low'] ?? 0) + ((_summary!['unresolvedBySeverity'] as Map)['info'] ?? 0)}',
              icon: PhosphorIconsDuotone.info,
              tone: severityStyle('low').tone,
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
        if (_error != null && a != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        TvCard(
          title: 'Alert queue',
          icon: PhosphorIconsDuotone.listMagnifyingGlass,
          description: a == null ? (_error != null ? 'Not loaded' : 'Loading…') : '${a.length} of $_total · highest severity first',
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
                            onChanged: (v) => _refilter(() => _status = v ?? 'active'),
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
                            onChanged: (v) => _refilter(() => _minSeverity = v ?? ''),
                          ),
                        ),
                      ],
                    ),
                    gap12,
                    TextField(
                      controller: _subject,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.search,
                      onSubmitted: (_) => _refilter(() {}),
                      decoration: fieldDeco(hint: 'Person (email)', icon: PhosphorIconsDuotone.magnifyingGlass),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, thickness: 1, color: p.divider),
              fadeSwap(
                context,
                a == null ? (_error != null ? 'error' : 'loading') : (a.isEmpty ? 'empty' : 'list'),
                a == null && _error != null
                    ? ErrorState(title: 'Could not load alerts', message: _error, onRetry: _load)
                    : a == null
                    ? const SkeletonRows(rows: 4)
                    : a.isEmpty
                    ? const EmptyState(icon: PhosphorIconsDuotone.shieldCheck, tone: Tone.green, title: 'Nothing here', body: 'No alerts match these filters.')
                    : RowList(
                        children: [
                          for (var i = 0; i < a.length; i++)
                            Rise(key: ValueKey(a[i]['id']), delay: (i < 8 ? i : 8) * 40, child: _row(context, p, a[i])),
                        ],
                      ),
              ),
              if (_cursor != null && a != null)
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Btn(
                    _loadingMore ? 'Loading…' : 'Load more',
                    icon: PhosphorIconsDuotone.arrowClockwise,
                    loading: _loadingMore,
                    expand: true,
                    onPressed: _loadingMore ? null : _more,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _row(BuildContext context, Pal p, Map a) {
    final status = a['status'] as String;
    return Semantics(
      button: true,
      child: InkWell(
      onTap: () async {
        await showAlertDetail(context, a['id'] as String);
        if (mounted) _load();
      },
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SeverityBar(a['severity'] as String?),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 12, 4, 12),
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
                        SeverityPill(a['severity'] as String?),
                        TvBadge(statusLabel(status), tone: statusTone(status), dot: true),
                        Text('${_human(a['rule'] as String)} · ${relativeTime(a['createdAt'] as String?)}', style: ts(context, size: 12, color: p.muted)),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Center(child: Ic(PhosphorIconsBold.caretRight, size: 14, color: p.faint)),
            ),
          ],
        ),
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

  /// The running action ('acknowledge', 'assign', …): only its button spins,
  /// the others wait (R9).
  String? _busy;

  @override
  void initState() {
    super.initState();
    _note.addListener(_changed);
    _load();
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    _note.removeListener(_changed);
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await Future.wait([Api.I.get('/admin/alert-queue/${widget.id}'), Api.I.get('/admin/alert-queue/reviewers')]);
      if (mounted) {
        setState(() {
          _data = res[0] as Map;
          _reviewers = ((res[1] as Map)['reviewers'] as List).cast<Map>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _act(String action, Map<String, dynamic> body) async {
    if (_busy != null) return;
    setState(() {
      _busy = action;
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
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    return fadeSwap(
      context,
      d != null ? 'ok' : (_error != null ? 'error' : 'loading'),
      d != null
          ? _content(context, d)
          : _error != null
          ? ErrorState(compact: true, title: 'Could not load this alert', message: _error, onRetry: _load)
          : const SkeletonRows(rows: 3),
    );
  }

  Widget _historyStep(BuildContext context, Pal p, Map h, bool last) {
    final (icon, tone) = _actionIcon[h['action']] ?? (PhosphorIconsDuotone.pulse, Tone.neutral);
    final t = toneOf(tone, p.dark);
    final extra = [
      if (h['action'] == 'assign' && h['assigneeEmail'] != null) 'to ${h['assigneeEmail']}',
      if (h['resolution'] != null) _human(h['resolution'] as String),
    ];
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Column(
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(color: t.bg, shape: BoxShape.circle, border: Border.all(color: t.ring)),
                child: Center(child: Ic(icon, size: 14, color: t.fg)),
              ),
              if (!last) Expanded(child: Container(width: 1.5, margin: const EdgeInsets.symmetric(vertical: 2), color: p.lineStrong)),
            ],
          ),
          gap12,
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: last ? 0 : 14, top: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(_actionLabel[h['action']] ?? statusLabel(h['action'] as String?), style: ts(context, size: 13, w: FontWeight.w600)),
                      TvBadge(statusLabel(h['statusAfter'] as String?), tone: statusTone(h['statusAfter'] as String?)),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    [h['actorEmail'] ?? 'system', formatDate(h['at'] as String?), ...extra].join(' · '),
                    style: ts(context, size: 12, color: p.muted),
                  ),
                  if (h['note'] != null)
                    Container(
                      margin: const EdgeInsets.only(top: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(10), border: Border.all(color: p.line)),
                      child: Text('“${h['note']}”', style: ts(context, size: 12.5, color: p.body, height: 1.45)),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _content(BuildContext context, Map d) {
    final p = Pal.of(context);
    final a = d['alert'] as Map;
    final history = (d['history'] as List).cast<Map>();
    final status = a['status'] as String;
    final resolved = status == 'resolved';
    final note = _note.text.trim();
    final s = severityStyle(a['severity'] as String?);
    final idle = _busy == null;
    final needsNote = note.length < 5;
    final reviewers = _reviewers.where((r) => r['id'] != a['subjectUserId']).toList();
    // A reviewer who left the list would crash the dropdown (value not in items).
    final assignee = reviewers.any((r) => r['id'] == _assignee) ? _assignee : null;
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
        Wrap(
          spacing: 6,
          runSpacing: 4,
          children: [SeverityPill(a['severity'] as String?), TvBadge(statusLabel(status), tone: statusTone(status), dot: true)],
        ),
        gap8,
        Text(a['message'] as String, style: ts(context, size: 14, w: FontWeight.w500, height: 1.45)),
        gap12,
        kv('Severity', '${s.label} · ${a['category']} · ${_human(a['rule'] as String)}'),
        kv('Raised', formatDate(a['createdAt'] as String?)),
        kv('Status', '${statusLabel(status)}${a['resolution'] != null ? ' (${_human(a['resolution'] as String)})' : ''}'),
        if (a['subjectEmail'] != null) kv('Person', a['subjectEmail'] as String),
        if (a['assigneeEmail'] != null) kv('Assigned to', a['assigneeEmail'] as String),
        if (a['observed'] != null) kv('Observed / threshold', '${a['observed']}${a['threshold'] != null ? ' / ${a['threshold']}' : ''}'),
        kv('Same person, 30 days', '${d['relatedAlerts30d']} other alerts'),
        gap16,
        Row(
          children: [
            Ic(PhosphorIconsDuotone.clockCounterClockwise, size: 16, color: p.muted),
            const SizedBox(width: 6),
            Text('History', style: ts(context, size: 14, w: FontWeight.w600)),
          ],
        ),
        gap8,
        if (history.isEmpty) Text('No review steps yet.', style: ts(context, size: 12.5, color: p.muted)),
        for (var i = 0; i < history.length; i++)
          Rise(delay: (i < 8 ? i : 8) * 40, dy: 6, child: _historyStep(context, p, history[i], i == history.length - 1)),
        gap16,
        FieldLabel(
          'Note',
          hint: 'Recorded in the history and the audit log',
          child: TextField(
            controller: _note,
            maxLines: 2,
            maxLength: 2000,
            textCapitalization: TextCapitalization.sentences,
            decoration: fieldDeco(hint: 'What you checked, what you found').copyWith(counterText: ''),
          ),
        ),
        // Says why Resolve / Reopen / Comment are disabled, right where the
        // note is typed (R9).
        AnimatedSwitcher(
          duration: Motion.of(context, Motion.fast),
          child: needsNote
              ? Padding(
                  key: const ValueKey('hint'),
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    note.isEmpty
                        ? 'Add a note of at least 5 characters to ${resolved ? 'reopen' : 'resolve'} or comment.'
                        : '${5 - note.length} more character${5 - note.length == 1 ? '' : 's'} to ${resolved ? 'reopen' : 'resolve'} or comment.',
                    style: ts(context, size: 12, color: p.faint),
                  ),
                )
              : const SizedBox(key: ValueKey('none'), width: double.infinity),
        ),
        gap12,
        if (status == 'open') ...[
          Btn(
            'Acknowledge',
            icon: PhosphorIconsDuotone.checkCircle,
            loading: _busy == 'acknowledge',
            expand: true,
            onPressed: idle ? () => _act('acknowledge', note.isEmpty ? {} : {'note': note}) : null,
          ),
          gap12,
        ],
        if (!resolved) ...[
          DropdownButtonFormField<String>(
            key: ValueKey('assignee-${reviewers.length}'),
            initialValue: assignee,
            isExpanded: true,
            decoration: fieldDeco(hint: 'Assign to…'),
            items: [
              for (final r in reviewers)
                DropdownMenuItem(value: r['id'] as String, child: Text(r['email'] as String, overflow: TextOverflow.ellipsis)),
            ],
            onChanged: idle ? (v) => setState(() => _assignee = v) : null,
          ),
          gap12,
          Btn(
            'Assign',
            icon: PhosphorIconsDuotone.userPlus,
            loading: _busy == 'assign',
            expand: true,
            onPressed: assignee == null || !idle ? null : () => _act('assign', {'assigneeId': assignee, if (note.isNotEmpty) 'note': note}),
          ),
          gap12,
          DropdownButtonFormField<String>(
            initialValue: _resolution,
            decoration: fieldDeco(),
            items: [for (final (id, label) in _resolutions) DropdownMenuItem(value: id, child: Text(label))],
            onChanged: idle ? (v) => setState(() => _resolution = v ?? 'true_positive') : null,
          ),
          gap12,
          Btn(
            'Resolve',
            variant: BtnVariant.primary,
            icon: PhosphorIconsDuotone.sealCheck,
            loading: _busy == 'resolve',
            expand: true,
            onPressed: needsNote || !idle ? null : () => _act('resolve', {'resolution': _resolution, 'note': note}),
          ),
        ],
        if (resolved)
          Btn(
            'Reopen',
            icon: PhosphorIconsDuotone.arrowCounterClockwise,
            loading: _busy == 'reopen',
            expand: true,
            onPressed: needsNote || !idle ? null : () => _act('reopen', {'note': note}),
          ),
        gap12,
        Btn(
          'Comment',
          variant: BtnVariant.ghost,
          icon: PhosphorIconsDuotone.pencilSimple,
          loading: _busy == 'comment',
          expand: true,
          onPressed: needsNote || !idle ? null : () => _act('comment', {'note': note}),
        ),
        if (_error != null) ...[gap12, Rise(dy: 6, child: TvAlert(_error!))],
        gap12,
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.only(top: 1), child: Ic(PhosphorIconsDuotone.info, size: 14, color: p.faint)),
            const SizedBox(width: 6),
            Expanded(
              child: Text('Resolving needs a note. An alert about you must be resolved by another administrator.', style: ts(context, size: 12, color: p.faint, height: 1.45)),
            ),
          ],
        ),
      ],
    );
  }
}
