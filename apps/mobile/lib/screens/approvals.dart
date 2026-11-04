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

  /// Error from a decision.
  String? _error;

  /// Error from the last load (R5).
  String? _loadError;

  /// `'$id:approve'` or `'$id:reject'` while a decision is in flight (R3).
  String? _deciding;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    try {
      final r = await Api.I.get('/download-requests') as Map;
      if (mounted && gen == _gen) {
        setState(() {
          _requests = (r['requests'] as List).cast<Map>();
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _loadError = errorText(e));
    }
  }

  Future<void> _decide(Map r, bool approve, int hours, int uses) async {
    if (_deciding != null) return;
    final id = r['id'] as String;
    final name = (r['requester'] as Map)['name'];
    final body = <String, dynamic>{};
    if (approve) {
      body.addAll({'hours': hours, 'uses': uses});
    } else {
      final note = await showSheet<String>(
        context,
        title: 'Decline this request?',
        icon: PhosphorIconsDuotone.prohibit,
        description: '$name will be told the request was declined. They can ask again.',
        builder: (_) => const _DeclineForm(),
      );
      if (note == null || !mounted || _deciding != null) return;
      if (note.isNotEmpty) body['note'] = note;
    }
    setState(() {
      _error = null;
      _deciding = '$id:${approve ? 'approve' : 'reject'}';
    });
    try {
      await Api.I.post('/download-requests/$id/${approve ? 'approve' : 'reject'}', body);
      if (!mounted) return;
      toast(context, approve ? '$name can download it now.' : 'Request declined. They were told.');
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _deciding = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final requests = _requests;
    return PageBody(
      onRefresh: _load,
      children: [
        const PageTitle(
          title: 'Download approvals',
          icon: PhosphorIconsDuotone.sealCheck,
          subtitle: 'People whose share asks for approval before downloading. Approve only what you expected; everything is recorded.',
        ),
        if (_error != null) ...[gap16, Rise(dy: 6, child: TvAlert(_error!, onDismiss: () => setState(() => _error = null)))],
        if (requests != null && _loadError != null) ...[
          gap16,
          TvAlert(_loadError!, tone: Tone.amber, title: 'Could not refresh', onDismiss: () => setState(() => _loadError = null)),
        ],
        gap16,
        // Skeleton → content cross-fades (§2.3).
        AnimatedSwitcher(
          duration: Motion.of(context),
          switchInCurve: Motion.curve,
          switchOutCurve: Motion.easeIn,
          layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
          child: requests == null && _loadError != null
              ? TvCard(key: const ValueKey('error'), padded: false, child: ErrorState(title: 'Could not load requests', message: _loadError, onRetry: _load))
              : requests == null
              ? const TvCard(key: ValueKey('loading'), padded: false, child: SkeletonRows(rows: 3))
              : requests.isEmpty
              ? const TvCard(
                  key: ValueKey('empty'),
                  padded: false,
                  child: EmptyState(icon: PhosphorIconsDuotone.checkCircle, tone: Tone.green, title: 'Nothing waiting', body: 'Requests appear here when someone asks to download a document whose share needs approval.'),
                )
              : Column(
                  key: const ValueKey('list'),
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = 0; i < requests.length; i++) ...[
                      Rise(
                        key: ValueKey('rise-${requests[i]['id']}'),
                        delay: (i < 8 ? i : 8) * 40,
                        child: _RequestCard(
                          key: ValueKey(requests[i]['id']),
                          r: requests[i],
                          p: p,
                          deciding: _deciding,
                          onDecide: _decide,
                        ),
                      ),
                      gap12,
                    ],
                  ],
                ),
        ),
      ],
    );
  }
}

class _RequestCard extends StatefulWidget {
  const _RequestCard({super.key, required this.r, required this.p, required this.deciding, required this.onDecide});
  final Map r;
  final Pal p;
  final String? deciding;
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
    final id = r['id'];
    final who = r['requester'] as Map;
    final doc = r['document'] as Map;
    final idle = widget.deciding == null;
    return TvCard(
      title: doc['title'] as String,
      icon: PhosphorIconsDuotone.downloadSimple,
      description: '${who['name']} (${who['email']}) · version ${r['versionNo']} · asked ${formatDate(r['createdAt'] as String?)}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              color: widget.p.soft,
              borderRadius: BorderRadius.circular(12),
              border: Border(left: BorderSide(color: widget.p.selectedBorder, width: 3)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.only(top: 2), child: Ic(PhosphorIconsDuotone.pencilSimple, size: 14, color: widget.p.muted)),
                const SizedBox(width: 8),
                Expanded(child: Text('“${r['reason']}”', style: ts(context, size: 14, color: widget.p.body, height: 1.45))),
              ],
            ),
          ),
          gap12,
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<int>(
                  initialValue: _hours,
                  isExpanded: true,
                  decoration: fieldDeco(hint: 'For', icon: PhosphorIconsDuotone.clockCounterClockwise),
                  items: [for (final h in [1, 4, 8, 24, 48, 72]) DropdownMenuItem(value: h, child: Text('$h hour${h == 1 ? '' : 's'}'))],
                  onChanged: idle ? (v) => setState(() => _hours = v ?? 24) : null,
                ),
              ),
              gap8,
              Expanded(
                child: DropdownButtonFormField<int>(
                  initialValue: _uses,
                  isExpanded: true,
                  decoration: fieldDeco(hint: 'Downloads', icon: PhosphorIconsDuotone.downloadSimple),
                  items: [for (final n in [1, 2, 3, 5, 10]) DropdownMenuItem(value: n, child: Text(n == 1 ? 'Once' : '$n times'))],
                  onChanged: idle ? (v) => setState(() => _uses = v ?? 1) : null,
                ),
              ),
            ],
          ),
          gap12,
          Row(
            children: [
              Expanded(
                child: Btn('Approve',
                    variant: BtnVariant.primary,
                    icon: PhosphorIconsBold.check,
                    expand: true,
                    loading: widget.deciding == '$id:approve',
                    onPressed: idle ? () => widget.onDecide(r, true, _hours, _uses) : null),
              ),
              gap8,
              Expanded(
                child: Btn('Decline',
                    icon: PhosphorIconsDuotone.prohibit,
                    expand: true,
                    loading: widget.deciding == '$id:reject',
                    onPressed: idle ? () => widget.onDecide(r, false, _hours, _uses) : null),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Decline confirmation with the optional note the API accepts. Pops the
/// trimmed note ('' for none), or null on Cancel.
class _DeclineForm extends StatefulWidget {
  const _DeclineForm();
  @override
  State<_DeclineForm> createState() => _DeclineFormState();
}

class _DeclineFormState extends State<_DeclineForm> {
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldLabel('Note to them (optional)',
            child: TextField(
              controller: _note,
              maxLines: 3,
              maxLength: 500,
              textCapitalization: TextCapitalization.sentences,
              decoration: fieldDeco(hint: 'e.g. Please use the shared copy instead').copyWith(counterText: ''),
            )),
        gap16,
        Row(
          children: [
            Expanded(child: Btn('Cancel', expand: true, onPressed: () => Navigator.of(context).pop())),
            gap8,
            Expanded(
              child: Btn('Decline', expand: true, variant: BtnVariant.danger, icon: PhosphorIconsDuotone.prohibit, onPressed: () => Navigator.of(context).pop(_note.text.trim())),
            ),
          ],
        ),
      ],
    );
  }
}
