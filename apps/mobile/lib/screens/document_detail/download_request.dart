part of '../document_detail.dart';

/* ------------------------------------------------------ access policies */

List<Widget> _conditionBadges(Map? policy) {
  if (policy == null) return const [];
  final w = policy['window'] as Map?;
  final nets = policy['networks'] as List?;
  return [
    if (policy['downloadApproval'] == true) const TvBadge('Downloads need approval', tone: Tone.amber),
    if (w != null) TvBadge('${w['start']}–${w['end']} ${w['timeZone']}', tone: Tone.blue),
    if (nets != null) TvBadge(nets.length == 1 ? nets.first as String : '${nets.length} networks', tone: Tone.violet),
  ];
}

/// For a share whose downloads need approval: ask with a reason, or download
/// with an approval the owner gave (THREATS.md P8). The server checks both.
class _ApprovalDownload extends StatefulWidget {
  const _ApprovalDownload({required this.docId, required this.versionNo, required this.fileName, this.requestable = true, this.requestStatus = 'NONE'});
  final String docId;
  final int versionNo;
  final String fileName;
  /// The server says this user may ask now (not PENDING/APPROVED, an approver
  /// exists, the version is not quarantined). Defaults true for the older shape.
  final bool requestable;
  /// Latest request state for the current version: NONE | PENDING | APPROVED | REJECTED.
  final String requestStatus;
  @override
  State<_ApprovalDownload> createState() => _ApprovalDownloadState();
}

class _ApprovalDownloadState extends State<_ApprovalDownload> {
  List<Map>? _mine;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/${widget.docId}/download-requests') as Map;
      if (mounted) setState(() => _mine = (r['requests'] as List).cast<Map>().where((x) => x['mine'] == true).toList());
    } catch (_) {
      if (mounted) setState(() => _mine = const []);
    }
  }

  Future<void> _ask() async {
    final sent = await showSheet<bool>(
      context,
      title: 'Ask to download',
      icon: PhosphorIconsDuotone.sealCheck,
      description: 'The owner gets an email and decides. If they approve, you can download this version for a limited time.',
      builder: (_) => _AskDownloadForm(docId: widget.docId, versionNo: widget.versionNo),
    );
    if (sent != true || !mounted) return;
    toast(context, 'Asked. The owner was emailed.');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final live = (_mine ?? const <Map>[]).where((r) =>
        r['status'] == 'APPROVED' && r['versionNo'] == widget.versionNo && r['validUntil'] != null &&
        DateTime.parse(r['validUntil'] as String).isAfter(now) && ((r['maxUses'] as int?) ?? 0) > (r['uses'] as int)).toList();
    final pending = widget.requestStatus == 'PENDING' || (_mine ?? const <Map>[]).any((r) => r['status'] == 'PENDING' && r['versionNo'] == widget.versionNo);
    if (live.isNotEmpty) {
      final left = (live.first['maxUses'] as int) - (live.first['uses'] as int);
      final path = '/documents/${widget.docId}/versions/${widget.versionNo}/download';
      // Each tap uses up one approved download: a second tap while one runs is ignored.
      return DownloadState(
        apiPath: path,
        builder: (context, downloading) => Btn(
          'Download (approved, $left left)',
          variant: BtnVariant.primary,
          size: BtnSize.lg,
          expand: true,
          icon: PhosphorIconsDuotone.downloadSimple,
          loading: downloading,
          onPressed: downloading
              ? null
              : () async {
                  await downloadAndOpen(context, documentId: widget.docId, versionNo: widget.versionNo, apiPath: path, fallbackName: widget.fileName);
                  await _load();
                },
        ),
      );
    }
    if (pending) {
      return const Btn('Waiting for the owner…', variant: BtnVariant.soft, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.clockCounterClockwise, onPressed: null);
    }
    // The owner declined, and the server does not let us ask again right now.
    if (widget.requestStatus == 'REJECTED' && !widget.requestable) {
      return const Btn('Request declined', variant: BtnVariant.secondary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.prohibit, onPressed: null);
    }
    return Btn(
      widget.requestStatus == 'REJECTED' ? 'Ask again to download' : 'Ask to download',
      variant: BtnVariant.primary,
      size: BtnSize.lg,
      expand: true,
      icon: PhosphorIconsDuotone.sealCheck,
      onPressed: _mine == null || !widget.requestable ? null : _ask,
    );
  }
}

/// The reason for a download request, with the server's 10-character
/// minimum checked here (live counter), a busy Send and errors shown in the
/// sheet, which stays open until the request is sent.
class _AskDownloadForm extends StatefulWidget {
  const _AskDownloadForm({required this.docId, required this.versionNo});
  final String docId;
  final int versionNo;
  @override
  State<_AskDownloadForm> createState() => _AskDownloadFormState();
}

class _AskDownloadFormState extends State<_AskDownloadForm> {
  static const _min = 10;
  final _reason = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reason.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  int get _length => _reason.text.trim().length;

  Future<void> _send() async {
    if (_busy || _length < _min) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.I.post('/documents/${widget.docId}/download-requests', {'reason': _reason.text.trim(), 'versionNo': widget.versionNo});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not send the request'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final short = _length < _min;
    return PopScope(
      canPop: !_busy,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FieldLabel(
            'Why do you need a copy?',
            child: TextField(
              controller: _reason,
              autofocus: true,
              enabled: !_busy,
              minLines: 3,
              maxLines: 5,
              maxLength: 500,
              textCapitalization: TextCapitalization.sentences,
              decoration: fieldDeco(hint: 'e.g. To sign and return it to the bank').copyWith(counterText: ''),
            ),
          ),
          const SizedBox(height: 6),
          Semantics(
            liveRegion: true,
            child: Text(
              short ? 'At least $_min characters (${_min - _length} more)' : '$_length / 500',
              textAlign: TextAlign.right,
              style: ts(context, size: 12, color: short ? p.muted : p.subtle),
            ),
          ),
          if (_error != null) ...[gap12, Semantics(liveRegion: true, child: TvAlert(_error!))],
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: Btn('Cancel', expand: true, icon: PhosphorIconsBold.x, onPressed: _busy ? null : () => Navigator.of(context).pop(false)),
              ),
              gap8,
              Expanded(
                child: Btn('Send request', expand: true, variant: BtnVariant.primary, icon: PhosphorIconsDuotone.envelope, loading: _busy, onPressed: short || _busy ? null : _send),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
