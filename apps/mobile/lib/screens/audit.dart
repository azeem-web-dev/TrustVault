import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/audit_ui.dart';
import '../widgets/files.dart';
import '../widgets/ui.dart';
import 'shell.dart';

const _emptyF = {'action': '', 'outcome': '', 'actor': '', 'documentId': '', 'from': '', 'to': ''};
final _quick = [
  ('Everything', '', PhosphorIconsDuotone.stack),
  ('Downloads', 'document.download', PhosphorIconsDuotone.downloadSimple),
  ('All document activity', 'document.', PhosphorIconsDuotone.files),
  ('Uploads', 'document.upload', PhosphorIconsDuotone.uploadSimple),
  ('Permission changes', 'access.', PhosphorIconsDuotone.lockKeyOpen),
  ('Group membership', 'group.member', PhosphorIconsDuotone.usersThree),
  ('Sign-ins', 'auth.', PhosphorIconsDuotone.signIn),
  ('Admin actions', 'admin.', PhosphorIconsDuotone.userGear),
];

/// Document activity and permission changes. Admins see metadata and titles, never file contents.
class AuditScreen extends StatefulWidget {
  const AuditScreen({super.key});
  @override
  State<AuditScreen> createState() => _AuditScreenState();
}

class _AuditScreenState extends State<AuditScreen> {
  Map<String, String> _applied = Map.of(_emptyF);
  List<Map>? _events;
  String? _next;
  String? _open;
  Map? _verify;
  String? _error;
  bool _busy = false;

  /// "Load older events" is running (R8).
  bool _loadingMore = false;

  /// Bumped by every new filter or refresh; answers for an older one are
  /// dropped, so a slow page never lands in a changed list (R8).
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String _query(Map<String, String> f, [String? before]) {
    final q = <String, String>{'limit': '50'};
    f.forEach((k, v) {
      if (v.isNotEmpty) q[k] = v;
    });
    if (before != null) q['before'] = before;
    return Uri(queryParameters: q).query;
  }

  Future<void> _load([String? before]) async {
    final more = before != null;
    if (more && (_loadingMore || _events == null)) return;
    final gen = more ? _gen : ++_gen;
    if (more) setState(() => _loadingMore = true);
    try {
      final r = await Api.I.get('/admin/audit?${_query(_applied, before)}') as Map;
      final ev = (r['events'] as List).cast<Map>();
      if (mounted && gen == _gen) {
        setState(() {
          if (more) {
            // Never show the same event twice, even if pages overlap.
            final seen = {for (final e in _events!) e['seq']};
            _events = [..._events!, ...ev.where((e) => !seen.contains(e['seq']))];
          } else {
            _events = ev;
          }
          _next = r['nextBefore'] as String?;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _error = errorText(e));
    } finally {
      if (more && mounted && gen == _gen) setState(() => _loadingMore = false);
    }
  }

  void _apply(Map<String, String> f) {
    setState(() {
      _applied = f;
      _events = null;
      _next = null;
      _open = null;
      _error = null;
      _loadingMore = false;
    });
    _load();
  }

  Future<void> _runVerify() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await Api.I.post('/admin/audit/checkpoint');
      final v = await Api.I.post('/admin/audit/verify') as Map;
      if (mounted) setState(() => _verify = v);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final advanced = ['outcome', 'actor', 'documentId', 'from', 'to'].where((k) => _applied[k]!.isNotEmpty).length + (_quick.any((q) => q.$2 == _applied['action']) ? 0 : 1);
    final ev = _events;
    return PageBody(
      onRefresh: () => _load(),
      children: [
        PageTitle(
          title: 'Audit log',
          icon: PhosphorIconsDuotone.listMagnifyingGlass,
          subtitle: 'Every upload, download, change, deletion, permission change and refused attempt. Append-only and hash-chained in the database.',
          actions: [
            Btn(_busy ? 'Verifying…' : 'Verify integrity', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.sealCheck, loading: _busy, onPressed: _runVerify),
            Btn(
              'Export evidence',
              icon: PhosphorIconsDuotone.export,
              onPressed: () => downloadExportAndOpen(context, '/admin/audit/export?fromSeq=1', fallbackName: 'trustvault-audit-bundle.json'),
            ),
          ],
        ),
        _IntegrityPanel(verify: _verify, busy: _busy, onVerify: _runVerify),
        gap16,
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final (label, action, icon) in _quick)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: TvChip(label, icon: icon, selected: _applied['action'] == action, onTap: () => _apply({...Map.of(_emptyF), 'action': action, 'outcome': _applied['outcome']!})),
                ),
              TvChip(
                'Refused only',
                icon: PhosphorIconsDuotone.prohibit,
                danger: true,
                selected: _applied['outcome'] == 'DENIED',
                onTap: () => _apply({..._applied, 'outcome': _applied['outcome'] == 'DENIED' ? '' : 'DENIED'}),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerRight,
          child: Btn(advanced > 0 ? 'More filters ($advanced)' : 'More filters', size: BtnSize.sm, variant: BtnVariant.ghost, icon: PhosphorIconsDuotone.funnelSimple, onPressed: _openFilters),
        ),
        const SizedBox(height: 6),
        if (_error != null && ev != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        TvCard(
          padded: false,
          // Skeleton → content cross-fades; rows rise in, staggered (§2.3).
          child: AnimatedSwitcher(
            duration: Motion.of(context),
            switchInCurve: Motion.curve,
            switchOutCurve: Motion.easeIn,
            layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
            child: KeyedSubtree(
              key: ValueKey(ev == null ? (_error != null ? 'error' : 'loading') : (ev.isEmpty ? 'empty' : 'list')),
              child: ev == null
                  ? (_error != null ? ErrorState(title: 'Could not load the audit log', message: _error, onRetry: () => _load()) : const SkeletonRows(rows: 8))
                  : ev.isEmpty
                  ? EmptyState(
                      icon: PhosphorIconsDuotone.listMagnifyingGlass,
                      title: 'No events match',
                      body: 'Try a wider time range or another filter.',
                      action: Btn('Show everything', icon: PhosphorIconsDuotone.stack, onPressed: () => _apply(Map.of(_emptyF))),
                    )
                  : RowList(
                      children: [
                        for (var i = 0; i < ev.length; i++)
                          Rise(key: ValueKey(ev[i]['seq']), delay: (i < 8 ? i : 8) * 40, child: _eventRow(context, p, ev[i])),
                      ],
                    ),
            ),
          ),
        ),
        if (_next != null && ev != null) ...[
          gap16,
          Center(
            child: Btn(
              _loadingMore ? 'Loading…' : 'Load older events',
              icon: PhosphorIconsDuotone.arrowClockwise,
              loading: _loadingMore,
              onPressed: _loadingMore ? null : () => _load(_next),
            ),
          ),
        ],
      ],
    );
  }

  Widget _eventRow(BuildContext context, Pal p, Map e) {
    final seq = e['seq'] as String;
    final isOpen = _open == seq;
    final outcome = e['outcome'] as String;
    return AnimatedContainer(
      duration: Motion.of(context),
      color: p.selectedBg.withValues(alpha: isOpen ? .5 : 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: isOpen,
            hint: isOpen ? 'Hide details' : 'Show details',
            child: InkWell(
            onTap: () => setState(() => _open = isOpen ? null : seq),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ActionIcon(e['action'] as String, outcome),
                  gap12,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                actionMeta(e['action'] as String).label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ts(context, size: 14, w: FontWeight.w600),
                              ),
                            ),
                            TvBadge(outcomeLabel(outcome), tone: outcomeTone[outcome] ?? Tone.neutral, dot: true),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '#$seq · ${e['action']}',
                          style: TextStyle(fontFamily: C.mono, fontSize: 11, color: p.faint),
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Avatar((e['actorEmail'] as String?) ?? 'system', size: 18),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                (e['actorEmail'] as String?) ?? 'system',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ts(context, size: 12, color: p.body),
                              ),
                            ),
                            Text('  ·  ${relativeTime(e['occurredAt'] as String?)}', style: ts(context, size: 12, color: p.faint)),
                          ],
                        ),
                        if (e['documentTitle'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Row(
                              children: [
                                Ic(PhosphorIconsDuotone.fileText, size: 13, color: p.muted),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: Text(
                                    e['documentTitle'] as String,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: ts(context, size: 12, w: FontWeight.w500, color: p.body),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        if (e['reason'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text((e['reason'] as String).replaceAll('_', ' '), style: ts(context, size: 11.5, color: p.muted)),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                  AnimatedRotation(
                    turns: isOpen ? .5 : 0,
                    duration: Motion.of(context),
                    child: Ic(PhosphorIconsBold.caretDown, size: 14, color: p.faint),
                  ),
                ],
              ),
            ),
          ),
          ),
          AnimatedSize(
            duration: Motion.of(context, const Duration(milliseconds: 220)),
            curve: Motion.curve,
            child: isOpen ? _details(context, p, e) : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }

  Widget _details(BuildContext context, Pal p, Map e) {
    Widget tile(PI icon, String label, String value, {bool mono = false}) => Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Ic(icon, size: 14, color: p.muted),
              const SizedBox(width: 5),
              Text(label, style: ts(context, size: 11.5, color: p.muted)),
            ],
          ),
          const SizedBox(height: 3),
          mono ? Mono(value, size: 11) : SelectableText(value, style: ts(context, size: 12, color: p.body)),
        ],
      ),
    );
    final docId = e['documentId'] as String?;
    final actor = e['actorEmail'] as String?;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          tile(PhosphorIconsDuotone.globe, 'IP address', (e['ip'] as String?) ?? '—', mono: true),
          tile(PhosphorIconsDuotone.desktop, 'Browser', (e['userAgent'] as String?) ?? '—'),
          tile(PhosphorIconsDuotone.target, 'Target', '${e['targetType'] ?? '—'} ${e['targetId'] ?? ''}', mono: true),
          tile(PhosphorIconsDuotone.hash, 'Chain hash', e['hash'] as String, mono: true),
          Row(
            children: [
              Ic(PhosphorIconsDuotone.calendarBlank, size: 14, color: p.muted),
              const SizedBox(width: 5),
              Text(formatDate(e['occurredAt'] as String?), style: ts(context, size: 12, color: p.muted)),
            ],
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              if (docId != null)
                Btn(
                  'All events for this document',
                  size: BtnSize.sm,
                  variant: BtnVariant.soft,
                  icon: PhosphorIconsDuotone.fileText,
                  trailing: PhosphorIconsBold.arrowRight,
                  onPressed: () => _apply({...Map.of(_emptyF), 'documentId': docId}),
                ),
              if (actor != null)
                Btn(
                  'Everything by $actor',
                  size: BtnSize.sm,
                  variant: BtnVariant.soft,
                  icon: PhosphorIconsDuotone.user,
                  trailing: PhosphorIconsBold.arrowRight,
                  onPressed: () => _apply({...Map.of(_emptyF), 'actor': actor}),
                ),
            ],
          ),
          const SizedBox(height: 8),
          if (e['details'] != null)
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: p.surface2,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.border),
              ),
              child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Mono(const JsonEncoder.withIndent('  ').convert(e['details']), size: 11)),
            ),
        ],
      ),
    );
  }

  Future<void> _openFilters() async {
    final f = Map<String, String>.of(_applied);
    final action = TextEditingController(text: f['action']);
    final actor = TextEditingController(text: f['actor']);
    final docId = TextEditingController(text: f['documentId']);
    final p = Pal.of(context);
    final res = await showSheet<Map<String, String>>(
      context,
      title: 'More filters',
      icon: PhosphorIconsDuotone.funnelSimple,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) {
          Future<void> pick(String key) async {
            final now = DateTime.now();
            final last = now.add(const Duration(days: 1));
            final cur = _localOf(f[key]!);
            final init = cur == null || cur.isAfter(last) ? now : cur;
            final d = await showDatePicker(context: ctx, firstDate: DateTime(2020), lastDate: last, initialDate: init);
            if (d == null || !ctx.mounted) return;
            final t = await showTimePicker(
              context: ctx,
              initialTime: cur != null ? TimeOfDay.fromDateTime(cur) : (key == 'to' ? const TimeOfDay(hour: 23, minute: 59) : const TimeOfDay(hour: 0, minute: 0)),
            );
            if (!ctx.mounted) return;
            // A missed time means the whole day: 00:00 for From, 23:59 for To.
            final dt = t != null
                ? DateTime(d.year, d.month, d.day, t.hour, t.minute)
                : key == 'to'
                ? DateTime(d.year, d.month, d.day, 23, 59, 59, 999)
                : DateTime(d.year, d.month, d.day);
            // Local wall time, sent as an exact UTC instant so the server
            // does not read it in its own time zone (R8).
            set(() => f[key] = dt.toUtc().toIso8601String());
          }

          Widget when(String key, String label) {
            final local = _localOf(f[key]!);
            return Expanded(
              child: FieldLabel(
                label,
                child: Press(
                  onTap: () => pick(key),
                  semanticLabel: '$label: ${local == null ? 'any time' : _show(local)}',
                  child: InputDecorator(
                    decoration: fieldDeco(
                      icon: PhosphorIconsDuotone.calendarBlank,
                      suffix: local == null ? null : IconBtn(PhosphorIconsBold.x, tooltip: 'Clear $label', size: 32, onPressed: () => set(() => f[key] = '')),
                    ),
                    child: Text(
                      local == null ? 'Any' : _show(local),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(ctx, size: 13, color: local == null ? p.muted : null),
                    ),
                  ),
                ),
              ),
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FieldLabel(
                'Action starts with',
                child: TextField(
                  controller: action,
                  decoration: fieldDeco(hint: 'document.'),
                ),
              ),
              gap12,
              FieldLabel(
                'Outcome',
                child: DropdownButtonFormField<String>(
                  initialValue: f['outcome'],
                  decoration: fieldDeco(),
                  items: const [
                    DropdownMenuItem(value: '', child: Text('Any')),
                    DropdownMenuItem(value: 'ALLOWED', child: Text('Allowed')),
                    DropdownMenuItem(value: 'DENIED', child: Text('Refused')),
                    DropdownMenuItem(value: 'FAILED', child: Text('Failed')),
                  ],
                  onChanged: (v) => set(() => f['outcome'] = v ?? ''),
                ),
              ),
              gap12,
              FieldLabel(
                'Actor email',
                child: TextField(
                  controller: actor,
                  keyboardType: TextInputType.emailAddress,
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.user),
                ),
              ),
              gap12,
              FieldLabel(
                'Document id',
                child: TextField(
                  controller: docId,
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.fileText),
                ),
              ),
              gap12,
              Row(children: [when('from', 'From'), gap12, when('to', 'To')]),
              gap24,
              Row(
                children: [
                  Expanded(
                    child: Btn(
                      'Filter',
                      variant: BtnVariant.primary,
                      expand: true,
                      icon: PhosphorIconsDuotone.funnelSimple,
                      onPressed: () {
                        f['action'] = action.text.trim();
                        f['actor'] = actor.text.trim();
                        f['documentId'] = docId.text.trim();
                        Navigator.pop(ctx, f);
                      },
                    ),
                  ),
                  gap8,
                  Btn('Clear', variant: BtnVariant.ghost, onPressed: () => Navigator.pop(ctx, Map<String, String>.of(_emptyF))),
                ],
              ),
            ],
          );
        },
      ),
    );
    if (res != null) _apply(res);
  }

  /// A stored From/To bound (UTC ISO) as local time; null when empty or
  /// unreadable.
  static DateTime? _localOf(String v) => v.isEmpty ? null : DateTime.tryParse(v)?.toLocal();

  /// 'YYYY-MM-DD HH:mm' in local time, for display only.
  static String _show(DateTime d) => '${isoDay(d)} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

class _IntegrityPanel extends StatelessWidget {
  const _IntegrityPanel({required this.verify, required this.busy, required this.onVerify});
  final Map? verify;
  final bool busy;
  final VoidCallback onVerify;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final v = verify;
    if (v == null) {
      return Rise(
        key: const ValueKey('integrity-intro'),
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: p.card,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: p.border),
            boxShadow: p.shadow,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Ic(PhosphorIconsDuotone.shieldCheck, size: 20, color: p.accent),
                  gap8,
                  Expanded(child: Text('Three independent protections keep this log honest', style: ts(context, size: 15, w: FontWeight.w600))),
                ],
              ),
              gap12,
              _protect(context, p, PhosphorIconsDuotone.gitCommit, 'Hash chain', 'Each event includes the hash of the one before. Change one and every later hash breaks.'),
              _protect(context, p, PhosphorIconsDuotone.key, 'Signed every minute', 'A separate key service signs the chain head. The database cannot forge it.'),
              _protect(context, p, PhosphorIconsDuotone.broadcast, 'Published outside', "Each signature goes to Sigstore's public log and a GitHub witness."),
              gap8,
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(18)),
                child: Column(
                  children: [
                    SvgPicture.asset('assets/art/chain_ok.svg', width: 210),
                    gap12,
                    Btn('Check it now', variant: BtnVariant.soft, icon: PhosphorIconsDuotone.sealCheck, loading: busy, onPressed: onVerify),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    }
    final ok = v['ok'] == true;
    final latest = v['latestCheckpoint'] as Map?;
    final problems = (v['problems'] as List?)?.cast<String>() ?? const [];
    final key = v['signingKey'] as Map;
    // Success / danger tone from the shared map (§2.1).
    final t = toneOf(ok ? Tone.green : Tone.red, p.dark);
    final okC = t.fg;
    final badC = t.fg;
    return Rise(
      key: ValueKey('integrity-$ok-${v['eventsChecked']}'),
      dy: 6,
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: t.ring),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [t.bg, p.card],
          ),
          boxShadow: p.shadow,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: ok ? C.emerald600 : C.red600,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [BoxShadow(color: t.dot.withValues(alpha: .35), blurRadius: 14, offset: const Offset(0, 6), spreadRadius: -4)],
                  ),
                  child: Center(child: Ic(ok ? PhosphorIconsFill.checkCircle : PhosphorIconsFill.shieldWarning, size: 26, color: severityStyle('critical').fg)),
                ),
                gap12,
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        ok ? 'Audit trail intact' : 'Audit trail FAILED verification',
                        style: ts(context, size: 17, w: FontWeight.w600, color: ok ? okC : badC),
                      ),
                      Text(ok ? 'Every event re-hashed in order and every signature checked.' : 'Something in the history was changed or removed.', style: ts(context, size: 12.5, color: p.body)),
                    ],
                  ),
                ),
              ],
            ),
            gap12,
            Center(child: SvgPicture.asset(ok ? 'assets/art/chain_ok.svg' : 'assets/art/chain_broken.svg', width: 220)),
            gap12,
            StatGrid(
              children: [
                _metric(context, p, 'Events re-hashed', '${v['eventsChecked']}', v['firstBadSeq'] != null ? 'first mismatch at #${v['firstBadSeq']}' : null),
                _metric(context, p, 'Signed checkpoints checked', '${v['checkpointsChecked']}', null),
              ],
            ),
            gap12,
            _metric(context, p, 'Latest checkpoint', latest == null ? '—' : '#${latest['seq']}', latest == null ? null : relativeTime(latest['createdAt'] as String?)),
            if (problems.isNotEmpty) ...[
              gap12,
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: t.bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.ring)),
                child: Column(
                  children: [
                    for (final pr in problems)
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Ic(PhosphorIconsDuotone.shieldWarning, size: 16, color: badC),
                          gap8,
                          Expanded(
                            child: Text(pr, style: ts(context, size: 13, color: badC)),
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ],
            gap12,
            Row(
              children: [
                Ic(PhosphorIconsDuotone.key, size: 14, color: p.muted),
                const SizedBox(width: 5),
                Expanded(child: Text('Signing key (${key['keyId']}):', style: ts(context, size: 12, color: p.muted))),
              ],
            ),
            Mono(key['publicKey'] as String, size: 10.5, color: p.muted),
            const SizedBox(height: 6),
            Text(
              'Exported bundles can be checked offline with node tools/verify-audit.mjs bundle.json --key <signing key above> --rekor, without trusting this server.',
              style: ts(context, size: 12, color: p.muted, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }

  Widget _protect(BuildContext context, Pal p, PI icon, String title, String text) => Container(
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: p.divider),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        IconTile(icon, size: 32),
        gap12,
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: ts(context, size: 13.5, w: FontWeight.w600)),
              Text(text, style: ts(context, size: 12, color: p.muted, height: 1.45)),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _metric(BuildContext context, Pal p, String label, String value, String? extra) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: p.dark ? p.soft : p.card.withValues(alpha: .75),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: p.line),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: ts(context, size: 12, color: p.muted)),
        const SizedBox(height: 4),
        Text(value, style: ts(context, size: 20, w: FontWeight.w600)),
        if (extra != null) Text(extra, style: ts(context, size: 12, color: extra.startsWith('first') ? p.danger : p.muted)),
      ],
    ),
  );
}
