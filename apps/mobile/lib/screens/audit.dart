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
    try {
      final r = await Api.I.get('/admin/audit?${_query(_applied, before)}') as Map;
      final ev = (r['events'] as List).cast<Map>();
      if (mounted) {
        setState(() {
          _events = before != null && _events != null ? [..._events!, ...ev] : ev;
          _next = r['nextBefore'] as String?;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  void _apply(Map<String, String> f) {
    setState(() {
      _applied = f;
      _events = null;
      _open = null;
    });
    _load();
  }

  Future<void> _runVerify() async {
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
              onPressed: () => downloadAndOpen(context, '/admin/audit/export?fromSeq=1', fallbackName: 'trustvault-audit-bundle.json'),
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
        if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        TvCard(
          padded: false,
          child: ev == null
              ? const SkeletonRows(rows: 8)
              : ev.isEmpty
              ? EmptyState(
                  icon: PhosphorIconsDuotone.listMagnifyingGlass,
                  title: 'No events match',
                  body: 'Try a wider time range or another filter.',
                  action: Btn('Show everything', onPressed: () => _apply(Map.of(_emptyF))),
                )
              : RowList(children: [for (final e in ev) _eventRow(context, p, e)]),
        ),
        if (_next != null) ...[
          gap16,
          Center(
            child: Btn('Load older events', icon: PhosphorIconsDuotone.arrowClockwise, onPressed: () => _load(_next)),
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
      duration: const Duration(milliseconds: 200),
      color: isOpen ? p.selectedBg.withValues(alpha: .5) : Colors.transparent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
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
                    duration: const Duration(milliseconds: 200),
                    child: Ic(PhosphorIconsBold.caretDown, size: 14, color: p.faint),
                  ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
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
          Text(formatDate(e['occurredAt'] as String?), style: ts(context, size: 12, color: p.muted)),
          Wrap(
            spacing: 4,
            children: [
              if (docId != null)
                TextButton(
                  onPressed: () => _apply({...Map.of(_emptyF), 'documentId': docId}),
                  child: Text(
                    'All events for this document →',
                    style: ts(context, size: 12.5, w: FontWeight.w600, color: p.accent),
                  ),
                ),
              if (actor != null)
                TextButton(
                  onPressed: () => _apply({...Map.of(_emptyF), 'actor': actor}),
                  child: Text(
                    'Everything by $actor →',
                    style: ts(context, size: 12.5, w: FontWeight.w600, color: p.accent),
                  ),
                ),
            ],
          ),
          if (e['details'] != null)
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: p.dark ? C.ink950 : Colors.white,
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
    final res = await showSheet<Map<String, String>>(
      context,
      title: 'More filters',
      icon: PhosphorIconsDuotone.funnelSimple,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) {
          Future<void> pick(String key) async {
            final now = DateTime.now();
            final d = await showDatePicker(context: ctx, firstDate: DateTime(2020), lastDate: now.add(const Duration(days: 1)), initialDate: now);
            if (d == null || !ctx.mounted) return;
            final t = await showTimePicker(context: ctx, initialTime: key == 'to' ? const TimeOfDay(hour: 23, minute: 59) : const TimeOfDay(hour: 0, minute: 0));
            final dt = DateTime(d.year, d.month, d.day, t?.hour ?? 0, t?.minute ?? 0);
            set(() => f[key] = '${isoDay(dt)}T${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}');
          }

          Widget when(String key, String label) => Expanded(
            child: FieldLabel(
              label,
              child: Press(
                onTap: () => pick(key),
                child: InputDecorator(
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.calendarBlank),
                  child: Text(f[key]!.isEmpty ? 'Any' : f[key]!.replaceAll('T', ' '), style: ts(ctx, size: 13, color: f[key]!.isEmpty ? C.slate400 : null)),
                ),
              ),
            ),
          );
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
              Text('Three independent protections keep this log honest', style: ts(context, size: 15, w: FontWeight.w600)),
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
    final okC = p.dark ? C.emerald300 : C.emerald800;
    final badC = p.dark ? C.red300 : C.red800;
    return Rise(
      dy: 6,
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: ok ? (p.dark ? C.emerald500.withValues(alpha: .25) : C.emerald200) : (p.dark ? C.red500.withValues(alpha: .3) : C.red200)),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [ok ? (p.dark ? C.emerald500.withValues(alpha: .10) : C.emerald50) : (p.dark ? C.red500.withValues(alpha: .10) : C.red50), p.card],
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
                    color: ok ? C.emerald500 : C.red500,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: [BoxShadow(color: (ok ? C.emerald500 : C.red500).withValues(alpha: .35), blurRadius: 14, offset: const Offset(0, 6))],
                  ),
                  child: Center(child: Ic(ok ? PhosphorIconsFill.checkCircle : PhosphorIconsFill.shieldWarning, size: 28, color: Colors.white)),
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
                decoration: BoxDecoration(color: p.dark ? C.red500.withValues(alpha: .1) : C.red100.withValues(alpha: .6), borderRadius: BorderRadius.circular(12)),
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
            Text('Signing key (${key['keyId']}):', style: ts(context, size: 12, color: p.muted)),
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
      color: p.dark ? Colors.white.withValues(alpha: .05) : Colors.white.withValues(alpha: .75),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: p.dark ? Colors.white.withValues(alpha: .1) : Colors.white),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: ts(context, size: 12, color: p.muted)),
        const SizedBox(height: 4),
        Text(value, style: ts(context, size: 20, w: FontWeight.w600)),
        if (extra != null) Text(extra, style: ts(context, size: 12, color: extra.startsWith('first') ? C.red600 : p.muted)),
      ],
    ),
  );
}
