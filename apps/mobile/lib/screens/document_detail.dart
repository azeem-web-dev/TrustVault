import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/secure_screen.dart';
import '../core/local_copies.dart';
import '../core/theme.dart';
import '../widgets/audit_ui.dart';
import '../widgets/files.dart';
import '../widgets/ui.dart';
import 'document_pages.dart';
import 'documents.dart' show uploadExtensions, uploadProblem;
import 'shell.dart';

part 'document_detail/overview.dart';
part 'document_detail/versions.dart';
part 'document_detail/access_panel.dart';
part 'document_detail/history.dart';
part 'document_detail/owner_actions.dart';
part 'document_detail/download_request.dart';

const _rank = {'NONE': 0, 'VIEW': 1, 'READ': 2, 'EDIT': 3, 'MANAGE': 4, 'OWNER': 5};

class DocumentDetailScreen extends StatefulWidget {
  const DocumentDetailScreen({super.key, required this.id});
  final String id;
  @override
  State<DocumentDetailScreen> createState() => _DocumentDetailScreenState();
}

class _DocumentDetailScreenState extends State<DocumentDetailScreen> {
  Map? _doc;
  bool _notFound = false;
  // A share that exists but does not apply right now (time window, network).
  String? _policyBlock;
  String? _error;
  String _tab = 'overview';
  /// An action (save, trash, transfer, …) is running: others wait.
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    // No screenshots or Recents preview while a document is open (THREATS.md V3).
    SecureScreen.hold();
    _load();
  }

  @override
  void dispose() {
    SecureScreen.release();
    super.dispose();
  }

  void _openPages(Map doc, bool viewOnly) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => DocumentPagesScreen(documentId: doc['id'] as String, title: doc['title'] as String, viewOnly: viewOnly)));
  }

  Future<void> _load() async {
    try {
      final d = await Api.I.get('/documents/${widget.id}') as Map;
      if (mounted) setState(() => _doc = d);
    } on ApiError catch (e) {
      if (!mounted) return;
      if (e.status == 404) {
        // Revoked, expired or deleted: no copy of it stays on the phone.
        await LocalCopies.removeFor(widget.id);
        if (!mounted) return;
        setState(() => _notFound = true);
      } else if (e.status == 403 && (e.code == 'outside_time_window' || e.code == 'network_not_allowed')) {
        setState(() => _policyBlock = e.message);
      } else {
        setState(() => _error = e.message);
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not load this document'));
    }
  }

  /// Try again after the document failed to load.
  Future<void> _retry() async {
    setState(() => _error = null);
    await _load();
  }

  /// Runs an action once (a second tap while it runs is ignored). True when
  /// it succeeded, so a form can close only then.
  Future<bool> _act(Future<void> Function() fn, String success, {VoidCallback? after}) async {
    if (_acting) return false;
    setState(() {
      _acting = true;
      _error = null;
    });
    try {
      await fn();
      if (!mounted) return true;
      toast(context, success);
      if (after != null) {
        after();
      } else {
        await _load();
      }
      return true;
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
      return false;
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  void _setError(String? m) => setState(() => _error = m);

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(child: Backdrop(dark: p.dark)),
          SafeArea(
            bottom: false,
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(6, 4, 12, 0),
                  child: Row(
                    children: [
                      TextButton.icon(
                        style: TextButton.styleFrom(minimumSize: const Size(kMinTap, kMinTap), foregroundColor: p.muted),
                        onPressed: () => Navigator.pop(context),
                        icon: Ic(PhosphorIconsBold.arrowLeft, size: 16, color: p.muted),
                        label: Text(
                          'Documents',
                          style: ts(context, size: 14, w: FontWeight.w500, color: p.muted),
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: Motion.of(context, Motion.base),
                    switchInCurve: Motion.easeOut,
                    child: KeyedSubtree(
                      key: ValueKey(
                        _policyBlock != null
                            ? 'policy'
                            : _notFound
                            ? 'gone'
                            : _doc != null
                            ? 'doc'
                            : _error != null
                            ? 'error'
                            : 'loading',
                      ),
                      child: _body(context, p),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context, Pal p) {
    if (_policyBlock != null) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TvCard(
            padded: false,
            child: EmptyState(
              icon: PhosphorIconsDuotone.lockKey,
              tone: Tone.amber,
              title: 'Not available right now',
              body: '$_policyBlock. The owner set this condition on your share; if you need it now, ask them for a temporary exception.',
              action: Btn('Back to documents', icon: PhosphorIconsBold.arrowLeft, onPressed: () => Navigator.pop(context)),
            ),
          ),
        ],
      );
    }
    if (_notFound) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TvCard(
            padded: false,
            child: EmptyState(
              icon: PhosphorIconsDuotone.prohibit,
              tone: Tone.slate,
              title: 'Nothing to see here',
              body: "This document does not exist, or you do not have access to it. We deliberately don't say which.",
              action: Btn('Back to documents', icon: PhosphorIconsBold.arrowLeft, onPressed: () => Navigator.pop(context)),
            ),
          ),
        ],
      );
    }
    final doc = _doc;
    if (doc == null) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_error != null)
            TvCard(
              padded: false,
              child: ErrorState(title: 'Could not open this document', message: _error, onRetry: _retry),
            )
          else ...[
            const Row(
              children: [
                Skeleton(width: 64, height: 64, radius: 18),
                gap16,
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Skeleton(width: 200, height: 22), gap8, Skeleton(width: 140)]),
                ),
              ],
            ),
            gap24,
            const Skeleton(height: 220, radius: 18),
            gap16,
            const Skeleton(height: 160, radius: 18),
          ],
        ],
      );
    }

    final access = doc['myAccess'] as String;
    final level = _rank[access] ?? 0;
    final trashed = doc['status'] == 'DELETED';
    final versions = (doc['versions'] as List).cast<Map>();
    final current = versions.isEmpty ? null : versions.first;
    final canManage = level >= _rank['MANAGE']!;
    final canDownload = level >= _rank['READ']!;
    // Prefer the API's `download` object (since 2026-11-04); otherwise fall back
    // to the older shape (READ access + the downloadNeedsApproval flag). This is
    // what lets a VIEW-only holder ask the owner for a one-file download (V1).
    final dl = doc['download'] as Map?;
    final canDownloadNow = dl != null ? dl['allowed'] == true : (canDownload && doc['downloadNeedsApproval'] != true);
    final requestStatus = (dl?['requestStatus'] as String?) ?? 'NONE';
    // Shown when the viewer cannot download yet but may ask, or already asked.
    final inRequestFlow = dl != null
        ? (dl['allowed'] != true && (dl['requestable'] == true || requestStatus != 'NONE'))
        : (doc['downloadNeedsApproval'] == true && !canDownloadNow);
    final owner = doc['owner'] as Map;
    final folder = doc['folder'] as Map?;
    final isOwner = doc['isOwner'] == true;
    if ((_tab == 'access' && (!canManage || trashed)) || (_tab == 'history' && !canManage)) _tab = 'overview';

    return PageBody(
      onRefresh: _load,
      children: [
        Rise(
          child: Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: p.card,
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: p.border),
              boxShadow: p.shadow,
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Positioned(
                  right: -70,
                  top: -80,
                  child: Container(
                    width: 220,
                    height: 220,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(colors: [C.brand500.withValues(alpha: .14), Colors.transparent]),
                    ),
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        FileIcon(current?['fileName'] as String?, size: 60),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Wrap(
                            spacing: 6,
                            runSpacing: 6,
                            children: [
                              TvBadge(doc['category'] as String, icon: PhosphorIconsDuotone.tag),
                              TvBadge('Your access: ${accessLabel[access]}', tone: accessTone[access] ?? Tone.neutral, dot: true),
                              if (trashed) const TvBadge('In the trash', tone: Tone.red, icon: PhosphorIconsDuotone.trash),
                              if (folder != null) TvBadge(folder['name'] as String, tone: Tone.blue, icon: PhosphorIconsDuotone.folderSimple),
                              if (current?['quarantine'] != null) const TvBadge('Quarantined', tone: Tone.red, icon: PhosphorIconsDuotone.biohazard),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Text(doc['title'] as String, style: ts(context, size: 23, w: FontWeight.w600, spacing: -0.5, height: 1.2)),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 14,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Avatar(owner['displayName'] as String, size: 20),
                            const SizedBox(width: 6),
                            Text(isOwner ? 'You own this' : owner['displayName'] as String, style: ts(context, size: 13, color: p.muted)),
                          ],
                        ),
                        if (current != null) Text('${fileType(current['fileName'] as String).label} · ${formatBytes(current['sizeBytes'] as num)}', style: ts(context, size: 13, color: p.muted)),
                        Text('Updated ${relativeTime(doc['updatedAt'] as String?)}', style: ts(context, size: 13, color: p.muted)),
                      ],
                    ),
                    if (current != null) ...[
                      const SizedBox(height: 16),
                      if (current['quarantine'] != null)
                        const Btn('Download blocked', icon: PhosphorIconsDuotone.prohibit, expand: true, onPressed: null)
                      else ...[
                        Btn(
                          canDownloadNow ? 'View pages' : 'View  ·  view only',
                          variant: canDownloadNow ? BtnVariant.secondary : BtnVariant.primary,
                          size: BtnSize.lg,
                          expand: true,
                          icon: PhosphorIconsDuotone.eye,
                          // "View only" in the viewer whenever a download is not
                          // possible right now (no READ, or it needs approval).
                          onPressed: () => _openPages(doc, !canDownloadNow),
                        ),
                        if (canDownloadNow) ...[
                          gap8,
                          DownloadState(
                            apiPath: '/documents/${doc['id']}/download',
                            builder: (context, downloading) => Btn(
                              'Download  ·  ${current['fileName']}',
                              variant: BtnVariant.primary,
                              size: BtnSize.lg,
                              expand: true,
                              icon: PhosphorIconsDuotone.downloadSimple,
                              loading: downloading,
                              onPressed: downloading
                                  ? null
                                  : () => downloadAndOpen(
                                      context,
                                      documentId: doc['id'] as String,
                                      versionNo: current['versionNo'] as int,
                                      apiPath: '/documents/${doc['id']}/download',
                                      fallbackName: current['fileName'] as String,
                                    ),
                            ),
                          ),
                        ] else if (inRequestFlow) ...[
                          gap8,
                          // A READ+ holder whose share needs approval, or a VIEW-only
                          // holder (V1): ask the owner, then download once allowed.
                          _ApprovalDownload(
                            docId: doc['id'] as String,
                            versionNo: current['versionNo'] as int,
                            fileName: current['fileName'] as String,
                            requestable: dl != null ? dl['requestable'] == true : true,
                            requestStatus: requestStatus,
                          ),
                        ],
                      ],
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
        if (_error != null) ...[gap16, Rise(key: ValueKey(_error), dy: 6, child: Semantics(liveRegion: true, child: TvAlert(_error!, onDismiss: () => setState(() => _error = null))))],
        gap16,
        Segmented<String>(
          value: _tab,
          onChanged: (t) => setState(() => _tab = t),
          options: [
            const SegOption('overview', 'Overview', icon: PhosphorIconsDuotone.info),
            SegOption('versions', 'Versions', icon: PhosphorIconsDuotone.stack, count: versions.length),
            if (canManage && !trashed) const SegOption('access', 'Access', icon: PhosphorIconsDuotone.shareNetwork),
            if (canManage) const SegOption('history', 'History', icon: PhosphorIconsDuotone.clockCounterClockwise),
          ],
        ),
        gap16,
        // Tab changes fade in (key = tab).
        AnimatedSwitcher(
          duration: Motion.of(context, const Duration(milliseconds: 180)),
          switchInCurve: Motion.easeOut,
          layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
          child: KeyedSubtree(
            key: ValueKey('tab-$_tab'),
            child: switch (_tab) {
              'versions' => _Versions(doc: doc, canDownload: canDownload || canDownloadNow, canDownloadNow: canDownloadNow, canUpload: level >= _rank['EDIT']! && !trashed, onUploaded: (note) => _act(() async {}, note == null ? 'New version uploaded' : 'New version uploaded. $note'), onError: _setError),
              'access' => _AccessPanel(doc: doc, onError: _setError),
              'history' => _History(docId: doc['id'] as String),
              _ => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _Details(doc: doc, canEdit: level >= _rank['EDIT']! && !trashed, onSave: (patch) => _act(() => Api.I.patch('/documents/${doc['id']}', patch), 'Details saved')),
                  gap16,
                  _ProtectionCard(isOwner: isOwner),
                ],
              ),
            },
          ),
        ),
        gap16,
        _AboutCard(doc: doc, canManage: canManage),
        if (isOwner) ...[
          gap16,
          _OwnerActions(
            doc: doc,
            busy: _acting,
            onTrash: () => _act(() => Api.I.post('/documents/${doc['id']}/trash'), 'Moved to the trash. Nobody else can reach it now.'),
            onRestore: () => _act(() => Api.I.post('/documents/${doc['id']}/restore'), 'Restored'),
            onPurge: () => _act(() => Api.I.delete('/documents/${doc['id']}'), 'Deleted permanently', after: () => Navigator.pop(context)),
            onTransfer: (id) => _act(
              () async {
                final r = await Api.I.post('/documents/${doc['id']}/transfer', {'newOwnerId': id});
                final still = r is Map ? r['stillHas'] as String? : null;
                if (still != null && context.mounted) toast(context, 'You no longer own it, but you can still ${_levelWord(still)} it through a group.', tone: Tone.amber);
              },
              'Ownership transferred',
              after: () => Navigator.pop(context),
            ),
            onMove: (folderId) => _act(() => Api.I.patch('/documents/${doc['id']}', {'folderId': folderId}), 'Moved'),
          ),
        ],
      ],
    );
  }
}

String _levelWord(String level) => const {'VIEW': 'view', 'READ': 'read', 'EDIT': 'edit', 'MANAGE': 'manage', 'OWNER': 'own'}[level] ?? 'open';

/// What the API says it rebuilt out of an uploaded PDF (THREATS.md C9):
/// `sanitized.removed` on POST /documents and /documents/:id/versions, and in
/// an upload event's history details. Mirrors apps/web/src/lib/sanitized.ts.
const _sanitizeWords = <String, String>{
  'JavaScript': 'JavaScript',
  'OpenAction': 'actions that run on opening',
  'Automatic actions (AA)': 'automatic actions',
  'Launch action': 'commands that start programs',
  'Links to other files (GoToR/GoToE)': 'links to other files',
  'ImportData action': 'form data import',
  'SubmitForm action': 'form submission',
  'EmbeddedFiles': 'attachments',
  'FileAttachment annotation': 'attachments',
  'RichMedia/3D/multimedia': 'embedded media',
  'XFA form': 'form fields',
  'Form fields (AcroForm)': 'form fields',
  'Non-web link (URI)': 'links to local files',
};

/// "Interactive content was removed for safety: JavaScript, attachments." or
/// null when nothing was removed (or the field is absent / not a PDF).
String? sanitizedNotice(Object? removed) {
  if (removed is! List || removed.isEmpty) return null;
  final words = <String>[];
  for (final r in removed) {
    final w = _sanitizeWords['$r'] ?? '$r';
    if (!words.contains(w)) words.add(w);
  }
  return 'Interactive content was removed for safety: ${words.join(', ')}.';
}

/// Pulls the sanitize note out of an upload response or a history event's details.
String? _sanitizedFrom(Object? node) {
  final sanitized = node is Map ? node['sanitized'] : null;
  return sanitizedNotice(sanitized is Map ? sanitized['removed'] : null);
}
