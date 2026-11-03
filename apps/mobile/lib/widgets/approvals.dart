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
  String? _error;
  String? _busy;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final r = await Api.I.get('/admin/approvals') as Map;
      if (mounted) setState(() => _rows = (r['approvals'] as List).cast<Map>());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _act(String id, Future<Object?> Function() work, String done) async {
    setState(() {
      _error = null;
      _busy = id;
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
          if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
          if (rows == null)
            const SkeletonRows(rows: 2)
          else if (rows.isEmpty)
            Text('No requests.', style: ts(context, size: 13, color: p.muted))
          else
            for (final a in rows) _row(context, p, a, me),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, Pal p, Map a, String? me) {
    final id = a['id'] as String;
    final status = a['status'] as String;
    final mine = (a['requestedBy'] as Map)['id'] == me;
    final mfa = a['action'] == 'MFA_RESET';
    final who = mfa
        ? 'second factor of ${(a['targetUser'] as Map?)?['email'] ?? '?'}'
        : 'break-glass on "${a['documentTitle'] ?? a['targetDocumentId']}"';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text('${mine ? 'You' : (a['requestedBy'] as Map)['displayName']} asked: $who', style: ts(context, size: 13.5, w: FontWeight.w600))),
              TvBadge(_label[status] ?? status, tone: _tone[status] ?? Tone.neutral, dot: true),
            ],
          ),
          const SizedBox(height: 4),
          Text('"${a['reason']}"', style: ts(context, size: 13, color: p.body)),
          const SizedBox(height: 2),
          Text('Asked ${relativeTime(a['createdAt'] as String?)}${a['approvedBy'] != null ? ' · approved by ${(a['approvedBy'] as Map)['displayName']}' : ''}',
              style: ts(context, size: 12, color: p.faint)),
          if (status == 'PENDING' && !mine) ...[
            gap8,
            Wrap(spacing: 8, children: [
              Btn('Approve', size: BtnSize.sm, variant: BtnVariant.primary, icon: PhosphorIconsDuotone.checkCircle, loading: _busy == id,
                  onPressed: () => _act(id, () => Api.I.post('/admin/approvals/$id/approve'), 'Approved. The admin who asked can now carry it out, once.')),
              Btn('Reject', size: BtnSize.sm, variant: BtnVariant.danger, icon: PhosphorIconsDuotone.prohibit,
                  onPressed: () => _act(id, () => Api.I.post('/admin/approvals/$id/reject'), 'Rejected')),
            ]),
          ],
          if (status == 'PENDING' && mine) ...[gap8, Text('Another administrator must answer.', style: ts(context, size: 12, color: p.muted))],
          if (status == 'APPROVED' && mine) ...[
            gap8,
            Btn(mfa ? 'Clear second factor now' : 'Open emergency access', size: BtnSize.sm, variant: BtnVariant.danger,
                icon: mfa ? PhosphorIconsDuotone.fingerprint : PhosphorIconsDuotone.siren, loading: _busy == id,
                onPressed: () => _act(
                      id,
                      () => mfa
                          ? Api.I.post('/admin/users/${(a['targetUser'] as Map)['id']}/mfa/reset', {'approvalId': id})
                          : Api.I.post('/admin/break-glass', {'documentId': a['targetDocumentId'], 'approvalId': id}),
                      mfa ? 'Second factor cleared; they were told by email' : 'Emergency access open for one hour',
                    )),
          ],
        ],
      ),
    );
  }
}

/// Asks for a second admin's approval; returns true when the request was made.
Future<bool> askApproval(BuildContext context, {required String title, required String description, required Map<String, Object?> body}) async {
  final reason = TextEditingController();
  final sent = await showSheet<bool>(
    context,
    title: title,
    icon: PhosphorIconsDuotone.shieldCheck,
    description: description,
    builder: (ctx) {
      String? error;
      var busy = false;
      return StatefulBuilder(
        builder: (ctx, set) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FieldLabel('Reason (at least 20 characters)',
                child: TextField(controller: reason, maxLines: 3, maxLength: 500, decoration: fieldDeco(hint: 'e.g. Lost phone, confirmed by video call').copyWith(counterText: ''))),
            if (error != null) ...[gap12, TvAlert(error!)],
            gap16,
            Btn('Ask for approval', variant: BtnVariant.primary, expand: true, loading: busy, onPressed: () async {
              set(() {
                busy = true;
                error = null;
              });
              try {
                await Api.I.post('/admin/approvals', {...body, 'reason': reason.text});
                if (ctx.mounted) Navigator.of(ctx).pop(true);
              } catch (e) {
                set(() {
                  error = errorText(e);
                  busy = false;
                });
              }
            }),
          ],
        ),
      );
    },
  );
  return sent == true;
}
