import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/ui.dart';
import 'shell.dart';

/// Download requests waiting for me: documents I own, or shares where the
/// owner nominated me (THREATS.md P8-P10). Approving lets that one person
/// download that one version, a set number of times, for a few hours. The
/// API and the database refuse anyone deciding their own request.
class ApprovalsScreen extends StatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  State<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends State<ApprovalsScreen> {
  List<Map>? _requests;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/download-requests') as Map;
      if (mounted) setState(() => _requests = (r['requests'] as List).cast<Map>());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _decide(Map r, bool approve, int hours, int uses) async {
    setState(() => _error = null);
    try {
      await Api.I.post('/download-requests/${r['id']}/${approve ? 'approve' : 'reject'}', approve ? {'hours': hours, 'uses': uses} : <String, dynamic>{});
      if (!mounted) return;
      toast(context, approve ? '${(r['requester'] as Map)['name']} can download it now.' : 'Request declined. They were told.');
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return PageBody(
      onRefresh: _load,
      children: [
        const PageTitle(
          title: 'Download approvals',
          icon: PhosphorIconsDuotone.sealCheck,
          subtitle: 'People whose share asks for approval before downloading. Approve only what you expected; everything is recorded.',
        ),
        if (_error != null) ...[gap16, TvAlert(_error!, onDismiss: () => setState(() => _error = null))],
        gap16,
        if (_requests == null)
          const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
        else if (_requests!.isEmpty)
          const TvCard(
            padded: false,
            child: EmptyState(icon: PhosphorIconsDuotone.checkCircle, tone: Tone.green, title: 'Nothing waiting', body: 'Requests appear here when someone asks to download a document whose share needs approval.'),
          )
        else
          for (final r in _requests!) ...[_RequestCard(r: r, p: p, onDecide: _decide), gap12],
      ],
    );
  }
}

class _RequestCard extends StatefulWidget {
  const _RequestCard({required this.r, required this.p, required this.onDecide});
  final Map r;
  final Pal p;
  final Future<void> Function(Map r, bool approve, int hours, int uses) onDecide;
  @override
  State<_RequestCard> createState() => _RequestCardState();
}

class _RequestCardState extends State<_RequestCard> {
  int _hours = 24;
  int _uses = 1;

  @override
  Widget build(BuildContext context) {
    final r = widget.r;
    final who = r['requester'] as Map;
    final doc = r['document'] as Map;
    return TvCard(
      title: doc['title'] as String,
      icon: PhosphorIconsDuotone.downloadSimple,
      description: '${who['name']} (${who['email']}) · version ${r['versionNo']} · asked ${formatDate(r['createdAt'] as String?)}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('“${r['reason']}”', style: ts(context, size: 14)),
          gap12,
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<int>(
                  initialValue: _hours,
                  decoration: fieldDeco(hint: 'For'),
                  items: [for (final h in [1, 4, 8, 24, 48, 72]) DropdownMenuItem(value: h, child: Text('$h hour${h == 1 ? '' : 's'}'))],
                  onChanged: (v) => setState(() => _hours = v ?? 24),
                ),
              ),
              gap8,
              Expanded(
                child: DropdownButtonFormField<int>(
                  initialValue: _uses,
                  decoration: fieldDeco(hint: 'Downloads'),
                  items: [for (final n in [1, 2, 3, 5, 10]) DropdownMenuItem(value: n, child: Text(n == 1 ? 'Once' : '$n times'))],
                  onChanged: (v) => setState(() => _uses = v ?? 1),
                ),
              ),
            ],
          ),
          gap12,
          Row(
            children: [
              Expanded(child: Btn('Approve', variant: BtnVariant.primary, icon: PhosphorIconsBold.check, expand: true, onPressed: () => widget.onDecide(r, true, _hours, _uses))),
              gap8,
              Expanded(child: Btn('Decline', icon: PhosphorIconsBold.x, expand: true, onPressed: () => widget.onDecide(r, false, _hours, _uses))),
            ],
          ),
        ],
      ),
    );
  }
}
