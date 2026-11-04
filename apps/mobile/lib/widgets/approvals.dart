import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/session.dart';
import '../core/theme.dart';
import 'phosphor.dart';
import 'ui.dart';

/// Requests that need a second administrator (THREATS.md S19): clearing an
/// owner's or admin's second factor, and break-glass. Another admin approves
/// or rejects; the admin who asked then carries it out, once.
class ApprovalsCard extends StatefulWidget {
  const ApprovalsCard({super.key});
  @override
  State<ApprovalsCard> createState() => ApprovalsCardState();
}

class ApprovalsCardState extends State<ApprovalsCard> {
  List<Map>? _rows;

  /// Error from an action (approve, reject, carry out).
  String? _error;

  /// Error from the last load, kept apart so a failed first load shows
  /// Try again instead of an endless skeleton (R5).
  String? _loadError;

  /// The running action: `'$id:approve'`, `'$id:reject'` or `'$id:run'`.
  String? _busy;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    final gen = ++_gen;
    try {
      final r = await Api.I.get('/admin/approvals') as Map;
      if (mounted && gen == _gen) {
        setState(() {
          _rows = (r['approvals'] as List).cast<Map>();
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _loadError = errorText(e));
    }
  }

  /// One action at a time: only the tapped button spins and every other
  /// button is disabled until it finishes (R4).
  Future<void> _act(String key, Future<Object?> Function() work, String done) async {
    if (_busy != null) return;
    setState(() {
      _error = null;
      _busy = key;
    });
    try {
      await work();
      if (mounted) toast(context, done);
      await load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  static const _tone = {'PENDING': Tone.amber, 'APPROVED': Tone.green, 'REJECTED': Tone.red, 'USED': Tone.neutral, 'EXPIRED': Tone.neutral};
  static const _label = {'PENDING': 'Waiting', 'APPROVED': 'Approved', 'REJECTED': 'Rejected', 'USED': 'Used', 'EXPIRED': 'Expired'};

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final me = context.watch<Session>().user?.id;
    final rows = _rows;
    return TvCard(
      title: 'Requests waiting for approval',
      icon: PhosphorIconsDuotone.shieldCheck,
      description: 'Clearing an owner\'s or admin\'s second factor, and break-glass, need a second administrator. With only one admin they are impossible.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null) ...[Rise(dy: 6, child: TvAlert(_error!, onDismiss: () => setState(() => _error = null))), gap12],
          if (rows != null && _loadError != null) ...[
            TvAlert(_loadError!, tone: Tone.amber, title: 'Could not refresh', onDismiss: () => setState(() => _loadError = null)),
            gap12,
          ],
          // Skeleton → content cross-fades; rows rise in, staggered (§2.3).
          AnimatedSwitcher(
            duration: Motion.of(context),
            switchInCurve: Motion.curve,
            switchOutCurve: Motion.easeIn,
            layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
            child: KeyedSubtree(
              key: ValueKey(rows == null ? (_loadError != null ? 'error' : 'loading') : (rows.isEmpty ? 'empty' : 'list')),
              child: rows == null && _loadError != null
                  ? ErrorState(compact: true, title: 'Could not load requests', message: _loadError, onRetry: load)
                  : rows == null
                  ? const SkeletonRows(rows: 2)
                  : rows.isEmpty
                  ? Row(
                      children: [
                        Ic(PhosphorIconsDuotone.checkCircle, size: 18, color: p.success),
                        gap8,
                        Expanded(child: Text('No requests waiting.', style: ts(context, size: 13, color: p.muted))),
                      ],
                    )
                  : RowList(
                      children: [
                        for (var i = 0; i < rows.length; i++)
                          Rise(key: ValueKey(rows[i]['id']), delay: (i < 8 ? i : 8) * 40, child: _row(context, p, rows[i], me)),
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _reject(String id) async {
    final ok = await showConfirm(
      context,
      'Reject this request?',
      'The admin who asked will not be able to carry it out. They can ask again with a new reason.',
      danger: true,
      confirmLabel: 'Reject',
      icon: PhosphorIconsDuotone.prohibit,
    );
    if (ok && mounted) await _act('$id:reject', () => Api.I.post('/admin/approvals/$id/reject'), 'Rejected');
  }

  Widget _row(BuildContext context, Pal p, Map a, String? me) {
    final id = a['id'] as String;
    final status = a['status'] as String;
    final mine = (a['requestedBy'] as Map)['id'] == me;
    final mfa = a['action'] == 'MFA_RESET';
    final who = mfa
        ? 'second factor of ${(a['targetUser'] as Map?)?['email'] ?? '?'}'
        : 'break-glass on "${a['documentTitle'] ?? a['targetDocumentId']}"';
    final idle = _busy == null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(mfa ? PhosphorIconsDuotone.fingerprint : PhosphorIconsDuotone.siren, tone: mfa ? Tone.violet : Tone.amber, size: 32),
              gap12,
              Expanded(child: Text('${mine ? 'You' : (a['requestedBy'] as Map)['displayName']} asked: $who', style: ts(context, size: 13.5, w: FontWeight.w600))),
              gap8,
              TvBadge(_label[status] ?? status, tone: _tone[status] ?? Tone.neutral, dot: true),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            decoration: BoxDecoration(
              color: p.soft,
              borderRadius: BorderRadius.circular(10),
              border: Border(left: BorderSide(color: p.selectedBorder, width: 3)),
            ),
            child: Text('“${a['reason']}”', style: ts(context, size: 13, color: p.body, height: 1.45)),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Ic(PhosphorIconsDuotone.clockCounterClockwise, size: 13, color: p.faint),
              const SizedBox(width: 4),
              Expanded(
                child: Text('Asked ${relativeTime(a['createdAt'] as String?)}${a['approvedBy'] != null ? ' · approved by ${(a['approvedBy'] as Map)['displayName']}' : ''}',
                    style: ts(context, size: 12, color: p.faint)),
              ),
            ],
          ),
          if (status == 'PENDING' && !mine) ...[
            gap8,
            Wrap(spacing: 8, runSpacing: 4, children: [
              Btn('Approve', size: BtnSize.sm, variant: BtnVariant.primary, icon: PhosphorIconsDuotone.checkCircle, loading: _busy == '$id:approve',
                  onPressed: idle ? () => _act('$id:approve', () => Api.I.post('/admin/approvals/$id/approve'), 'Approved. The admin who asked can now carry it out, once.') : null),
              Btn('Reject', size: BtnSize.sm, variant: BtnVariant.danger, icon: PhosphorIconsDuotone.prohibit, loading: _busy == '$id:reject',
                  onPressed: idle ? () => _reject(id) : null),
            ]),
          ],
          if (status == 'PENDING' && mine) ...[
            gap8,
            Row(
              children: [
                Ic(PhosphorIconsDuotone.usersThree, size: 14, color: p.warning),
                const SizedBox(width: 6),
                Expanded(child: Text('Another administrator must answer.', style: ts(context, size: 12, color: p.muted))),
              ],
            ),
          ],
          if (status == 'APPROVED' && mine) ...[
            gap8,
            Btn(mfa ? 'Clear second factor now' : 'Open emergency access', size: BtnSize.sm, variant: BtnVariant.danger,
                icon: mfa ? PhosphorIconsDuotone.fingerprint : PhosphorIconsDuotone.siren, loading: _busy == '$id:run',
                onPressed: idle
                    ? () => _act(
                          '$id:run',
                          () => mfa
                              ? Api.I.post('/admin/users/${(a['targetUser'] as Map)['id']}/mfa/reset', {'approvalId': id})
                              : Api.I.post('/admin/break-glass', {'documentId': a['targetDocumentId'], 'approvalId': id}),
                          mfa ? 'Second factor cleared; they were told by email' : 'Emergency access open for one hour',
                        )
                    : null),
          ],
        ],
      ),
    );
  }
}

/// Asks for a second admin's approval; returns true when the request was made.
Future<bool> askApproval(BuildContext context, {required String title, required String description, required Map<String, Object?> body}) async {
  final sent = await showSheet<bool>(
    context,
    title: title,
    icon: PhosphorIconsDuotone.shieldCheck,
    description: description,
    builder: (_) => _AskApprovalForm(body: body),
  );
  return sent == true;
}

/// The form owns its text, error and busy flag in a State, so they survive
/// the sheet rebuilding when the keyboard opens or closes (R1).
class _AskApprovalForm extends StatefulWidget {
  const _AskApprovalForm({required this.body});
  final Map<String, Object?> body;
  @override
  State<_AskApprovalForm> createState() => _AskApprovalFormState();
}

class _AskApprovalFormState extends State<_AskApprovalForm> {
  static const _min = 20;
  final _reason = TextEditingController();
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
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.I.post('/admin/approvals', {...widget.body, 'reason': _reason.text});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = errorText(e);
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final len = _reason.text.trim().length;
    final left = _min - len;
    return PopScope(
      canPop: !_busy,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FieldLabel('Reason (at least $_min characters)',
              child: TextField(
                controller: _reason,
                readOnly: _busy,
                maxLines: 3,
                maxLength: 500,
                textCapitalization: TextCapitalization.sentences,
                decoration: fieldDeco(hint: 'e.g. Lost phone, confirmed by video call').copyWith(counterText: ''),
              )),
          const SizedBox(height: 6),
          Row(
            children: [
              AnimatedSwitcher(
                duration: Motion.of(context, Motion.fast),
                child: left > 0
                    ? Ic(PhosphorIconsDuotone.pencilSimple, key: const ValueKey('more'), size: 13, color: p.faint)
                    : Ic(PhosphorIconsFill.checkCircle, key: const ValueKey('ok'), size: 13, color: p.success),
              ),
              const SizedBox(width: 5),
              Text(left > 0 ? '$left more character${left == 1 ? '' : 's'} needed' : '$len / 500',
                  style: ts(context, size: 12, color: left > 0 ? p.faint : p.success)),
            ],
          ),
          if (_error != null) ...[gap12, Rise(dy: 6, child: TvAlert(_error!))],
          gap16,
          Btn('Ask for approval', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.shieldCheck, expand: true, loading: _busy, onPressed: left > 0 ? null : _submit),
        ],
      ),
    );
  }
}
