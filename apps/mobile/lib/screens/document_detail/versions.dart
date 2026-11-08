part of '../document_detail.dart';

/* --------------------------------------------------------------- versions */

class _Versions extends StatefulWidget {
  const _Versions({required this.doc, required this.canDownload, required this.canDownloadNow, required this.canUpload, required this.onUploaded, required this.onError});
  final Map doc;
  final bool canDownload;
  /// Allowed right now (the API's `download.allowed`); false when the share
  /// needs the owner's approval first.
  final bool canDownloadNow;
  final bool canUpload;
  final ValueChanged<String?> onUploaded;
  final ValueChanged<String?> onError;
  @override
  State<_Versions> createState() => _VersionsState();
}

class _VersionsState extends State<_Versions> {
  bool _busy = false;

  Future<void> _upload() async {
    if (_busy) return;
    final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: uploadExtensions);
    if (f == null || !mounted) return;
    final problem = uploadProblem(f.name, await f.length() ?? 0);
    if (problem != null) {
      widget.onError(problem);
      return;
    }
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      final r = await Api.I.upload('/documents/${widget.doc['id']}/versions', bytes: await f.readAsBytes(), fileName: f.name);
      widget.onUploaded(_sanitizedFrom(r));
    } catch (e) {
      widget.onError(errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final versions = (widget.doc['versions'] as List).cast<Map>();
    return TvCard(
      title: 'Versions',
      icon: PhosphorIconsDuotone.stack,
      description: 'Every version is kept, encrypted and hash-checked on download.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < versions.length; i++)
            Rise(
              key: ValueKey('v-${versions[i]['versionNo']}'),
              delay: 40 * i.clamp(0, 8),
              dy: 6,
              child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Column(
                    children: [
                      FileIcon(versions[i]['fileName'] as String, size: 38),
                      if (i < versions.length - 1)
                        Expanded(
                          child: Container(width: 1.2, margin: const EdgeInsets.symmetric(vertical: 4), color: p.border),
                        ),
                    ],
                  ),
                  gap12,
                  Expanded(
                    child: Padding(padding: const EdgeInsets.only(bottom: 12), child: _versionCard(context, p, versions[i], i == 0)),
                  ),
                ],
              ),
            ),
            ),
          if (widget.canUpload) ...[
            gap4,
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.dashed),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Ic(PhosphorIconsDuotone.cloudArrowUp, size: 16, color: p.accent),
                      gap8,
                      Expanded(child: Text('Upload a new version', style: ts(context, size: 13.5, w: FontWeight.w600))),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text('Scanned for malware and encrypted before it is stored.', style: ts(context, size: 12, color: p.muted)),
                  gap12,
                  Btn(_busy ? 'Uploading…' : 'Choose file and upload', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.cloudArrowUp, loading: _busy, expand: true, onPressed: _busy ? null : _upload),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _versionCard(BuildContext context, Pal p, Map v, bool current) {
    final q = v['quarantine'] as Map?;
    final red = toneOf(Tone.red, p.dark);
    final brand = toneOf(Tone.brand, p.dark);
    final border = q != null
        ? red.ring
        : current
        ? brand.ring
        : p.divider;
    final bg = q != null
        ? red.bg
        : current
        ? p.selectedBg
        : p.surface.withValues(alpha: 0);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Version ${v['versionNo']}', style: ts(context, size: 14, w: FontWeight.w600)),
              if (current) ...[gap8, const TvBadge('Current', tone: Tone.violet)],
              const Spacer(),
              q != null
                  ? const TvBadge('Download blocked', tone: Tone.red, icon: PhosphorIconsDuotone.prohibit)
                  : !widget.canDownload
                  ? const TvBadge('View only', icon: PhosphorIconsDuotone.eyeSlash)
                  : !widget.canDownloadNow
                  // Says why instead of a greyed-out button: the header has "Ask to download".
                  ? const TvBadge('Needs approval', tone: Tone.amber, icon: PhosphorIconsDuotone.sealCheck)
                  : DownloadState(
                      apiPath: '/documents/${widget.doc['id']}/versions/${v['versionNo']}/download',
                      builder: (context, downloading) => Btn(
                        'Download',
                        size: BtnSize.sm,
                        icon: PhosphorIconsDuotone.downloadSimple,
                        loading: downloading,
                        onPressed: downloading
                            ? null
                            : () => downloadAndOpen(
                                context,
                                documentId: widget.doc['id'] as String,
                                versionNo: v['versionNo'] as int,
                                apiPath: '/documents/${widget.doc['id']}/versions/${v['versionNo']}/download',
                                fallbackName: v['fileName'] as String,
                              ),
                      ),
                    ),
            ],
          ),
          const SizedBox(height: 4),
          Text('${v['fileName']} · ${formatBytes(v['sizeBytes'] as num)} · by ${v['uploadedBy']}, ${relativeTime(v['createdAt'] as String?)}', style: ts(context, size: 12, color: p.muted)),
          if (q != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Ic(PhosphorIconsDuotone.biohazard, size: 16, color: red.fg),
                  gap8,
                  Expanded(
                    child: Text(
                      'Quarantined ${formatDate(q['foundAt'] as String?)}: the malware scanner found ${q['signature']}',
                      style: ts(context, size: 12, w: FontWeight.w500, color: red.fg),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
