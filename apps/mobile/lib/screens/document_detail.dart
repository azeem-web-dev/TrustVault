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

/* ------------------------------------------------------------------ about */

class _AboutCard extends StatelessWidget {
  const _AboutCard({required this.doc, required this.canManage});
  final Map doc;
  final bool canManage;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final versions = (doc['versions'] as List).cast<Map>();
    final current = versions.isEmpty ? null : versions.first;
    final owner = doc['owner'] as Map;
    Widget row(PI icon, String label, Widget value) => Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Ic(icon, size: 16, color: p.subtle),
          ),
          gap12,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: ts(context, size: 12, color: p.muted)),
                const SizedBox(height: 2),
                value,
              ],
            ),
          ),
        ],
      ),
    );
    final v = ts(context, size: 14, w: FontWeight.w500);
    return TvCard(
      title: 'About',
      icon: PhosphorIconsDuotone.info,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          row(
            PhosphorIconsDuotone.crown,
            'Owner',
            doc['isOwner'] == true
                ? Text('You', style: v)
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(owner['displayName'] as String, style: v),
                      Text(owner['email'] as String, style: ts(context, size: 12, color: p.muted)),
                    ],
                  ),
          ),
          row(PhosphorIconsDuotone.calendarBlank, 'Created', Text(formatDate(doc['createdAt'] as String?), style: v)),
          row(PhosphorIconsDuotone.pencilSimple, 'Last changed', Text(formatDate(doc['updatedAt'] as String?), style: v)),
          if (current != null)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Ic(PhosphorIconsDuotone.hash, size: 16, color: p.subtle),
                ),
                gap12,
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text('SHA-256 of current version', style: ts(context, size: 12, color: p.muted)),
                          ),
                          CopyBtn(current['sha256'] as String, label: 'Copy SHA-256'),
                        ],
                      ),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(10), border: Border.all(color: p.line)),
                        child: Mono(current['sha256'] as String, size: 11),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          if (!canManage) ...[
            gap16,
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line)),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Ic(PhosphorIconsDuotone.info, size: 16, color: p.info),
                  gap8,
                  Expanded(
                    child: Text(
                      'You can see this document because someone shared it with you. Only people with Manage access can see who else has it.',
                      style: ts(context, size: 12, color: p.muted, height: 1.5),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ProtectionCard extends StatelessWidget {
  const _ProtectionCard({required this.isOwner});
  final bool isOwner;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final items = [
      (PhosphorIconsDuotone.lockKey, 'Encrypted at rest', 'Its own key, wrapped by a separate key service.', Tone.brand),
      (PhosphorIconsDuotone.bug, 'Malware-scanned', 'On upload, and again every night with new signatures.', Tone.green),
      (PhosphorIconsDuotone.fingerprint, 'Every access recorded', 'Views, downloads and refusals go into the signed audit trail.', Tone.violet),
      (
        PhosphorIconsDuotone.shieldCheck,
        isOwner ? 'Only you decide' : 'Shared on purpose',
        isOwner ? 'Nobody sees it unless you share it with them.' : 'Access was granted to you for this document only.',
        Tone.amber,
      ),
    ];
    return TvCard(
      title: 'How this document is protected',
      icon: PhosphorIconsDuotone.shieldCheck,
      child: Column(
        children: [
          for (final (i, (icon, title, text, tone)) in items.indexed)
            Rise(
              delay: 40 * i,
              dy: 6,
              child: Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.divider),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  IconTile(icon, tone: tone, size: 34),
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
            ),
            ),
        ],
      ),
    );
  }
}

/* ---------------------------------------------------------------- details */

class _Details extends StatefulWidget {
  const _Details({required this.doc, required this.canEdit, required this.onSave});
  final Map doc;
  final bool canEdit;
  /// True when saved; the editor stays open (with the user's edits) otherwise.
  final Future<bool> Function(Map<String, dynamic>) onSave;
  @override
  State<_Details> createState() => _DetailsState();
}

class _DetailsState extends State<_Details> {
  bool _editing = false;
  bool _saving = false;
  String? _invalid;
  late final _title = TextEditingController();
  late final _category = TextEditingController();
  late final _desc = TextEditingController();

  void _reset() {
    _title.text = widget.doc['title'] as String;
    _category.text = widget.doc['category'] as String;
    _desc.text = (widget.doc['description'] as String?) ?? '';
  }

  @override
  void initState() {
    super.initState();
    _reset();
  }

  @override
  void didUpdateWidget(covariant _Details old) {
    super.didUpdateWidget(old);
    // A refresh while editing must not wipe what the user typed.
    if (old.doc != widget.doc && !_editing) _reset();
  }

  @override
  void dispose() {
    _title.dispose();
    _category.dispose();
    _desc.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    final title = _title.text.trim();
    final category = _category.text.trim();
    if (title.isEmpty || category.isEmpty) {
      setState(() => _invalid = title.isEmpty ? 'Give the document a title.' : 'Give the document a category.');
      return;
    }
    setState(() {
      _saving = true;
      _invalid = null;
    });
    final desc = _desc.text.trim();
    final ok = await widget.onSave({'title': title, 'category': category, 'description': desc.isEmpty ? null : desc});
    if (!mounted) return;
    setState(() {
      _saving = false;
      if (ok) _editing = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final desc = widget.doc['description'] as String?;
    return TvCard(
      title: 'Details',
      icon: PhosphorIconsDuotone.pencilSimple,
      actions: widget.canEdit && !_editing
          ? Btn(
              'Edit',
              size: BtnSize.sm,
              icon: PhosphorIconsDuotone.pencilSimple,
              onPressed: () => setState(() {
                _reset();
                _editing = true;
              }),
            )
          : null,
      child: AnimatedSize(
        duration: Motion.of(context, Motion.base),
        curve: Motion.easeOut,
        alignment: Alignment.topCenter,
        child: AnimatedSwitcher(
          duration: Motion.of(context, Motion.base),
          child: _editing
          ? Column(
              key: const ValueKey('edit'),
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FieldLabel(
                  'Title',
                  child: TextField(
                    controller: _title,
                    maxLength: 200,
                    enabled: !_saving,
                    textInputAction: TextInputAction.next,
                    onChanged: (_) {
                      if (_invalid != null) setState(() => _invalid = null);
                    },
                    decoration: fieldDeco().copyWith(counterText: ''),
                  ),
                ),
                gap12,
                FieldLabel(
                  'Category',
                  child: TextField(
                    controller: _category,
                    maxLength: 60,
                    enabled: !_saving,
                    textInputAction: TextInputAction.next,
                    onChanged: (_) {
                      if (_invalid != null) setState(() => _invalid = null);
                    },
                    decoration: fieldDeco().copyWith(counterText: ''),
                  ),
                ),
                gap12,
                FieldLabel(
                  'Description',
                  child: TextField(
                    controller: _desc,
                    maxLines: 4,
                    maxLength: 2000,
                    enabled: !_saving,
                    decoration: fieldDeco().copyWith(counterText: ''),
                  ),
                ),
                if (_invalid != null) ...[gap12, Semantics(liveRegion: true, child: TvAlert(_invalid!))],
                gap16,
                Row(
                  children: [
                    Btn('Save', variant: BtnVariant.primary, icon: PhosphorIconsBold.check, loading: _saving, onPressed: _saving ? null : _save),
                    gap8,
                    Btn(
                      'Cancel',
                      variant: BtnVariant.ghost,
                      icon: PhosphorIconsBold.x,
                      onPressed: _saving
                          ? null
                          : () => setState(() {
                              _editing = false;
                              _invalid = null;
                              _reset();
                            }),
                    ),
                  ],
                ),
              ],
            )
          : (desc == null || desc.isEmpty)
          ? SizedBox(
              key: const ValueKey('empty'),
              width: double.infinity,
              child: Text(
                'No description.',
                style: ts(context, size: 14, color: p.subtle).copyWith(fontStyle: FontStyle.italic),
              ),
            )
          : SizedBox(
              key: ValueKey('desc-$desc'),
              width: double.infinity,
              child: Text(desc, style: ts(context, size: 14, color: p.body, height: 1.55)),
            ),
        ),
      ),
    );
  }
}

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

/* ----------------------------------------------------------------- access */

const _levels = [
  ('VIEW', 'View only', 'Pages in TrustVault, marked with their name. No download', PhosphorIconsDuotone.eyeSlash),
  ('READ', 'Download', 'Also download a copy stamped with their name', PhosphorIconsDuotone.downloadSimple),
  ('EDIT', 'Edit', 'Also rename, upload versions', PhosphorIconsDuotone.pencilSimple),
  ('MANAGE', 'Manage', 'Also share, see history', PhosphorIconsDuotone.shareNetwork),
];

class _AccessPanel extends StatefulWidget {
  const _AccessPanel({required this.doc, required this.onError});
  final Map doc;
  final ValueChanged<String?> onError;
  @override
  State<_AccessPanel> createState() => _AccessPanelState();
}

class _AccessPanelState extends State<_AccessPanel> {
  List<Map>? _grants;
  List<Map>? _suggestions;
  final _query = TextEditingController();
  Timer? _t;
  List<Map> _users = [];
  List<Map> _groups = [];
  ({String type, String id, String label, bool external})? _target;
  String _level = 'READ';
  String _expires = '';
  // Conditions on the share (THREATS.md P1-P12). The web app also offers networks.
  bool _needsApproval = false;
  bool _workHours = false;
  final _zone = TextEditingController(text: 'UTC');
  /// People search: only the newest answer counts; the field shows progress
  /// and "nobody matches" instead of silently showing nothing.
  int _seq = 0;
  bool _searching = false;
  bool _searched = false;
  String? _searchError;
  /// One share at a time (the form or a suggestion).
  bool _sharing = false;
  /// Grants being removed, and groups whose waiting members are being confirmed.
  final _revoking = <String>{};
  final _confirming = <String>{};
  bool _loadingSuggestions = false;

  String get _docId => widget.doc['id'] as String;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _t?.cancel();
    _query.dispose();
    _zone.dispose();
    super.dispose();
  }

  String? _loadError;

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/$_docId/access') as Map;
      if (mounted) {
        setState(() {
          _grants = (r['grants'] as List).cast<Map>();
          _loadError = null;
        });
      }
    } catch (e) {
      if (!mounted) return;
      // Before the first list: say so in the card (no endless skeleton).
      if (_grants == null) {
        setState(() => _loadError = errorText(e));
      } else {
        widget.onError(errorText(e));
      }
    }
  }

  void _search(String q) {
    _t?.cancel();
    final my = ++_seq;
    if (q.trim().length < 2) {
      setState(() {
        _users = [];
        _groups = [];
        _searching = false;
        _searched = false;
        _searchError = null;
      });
      return;
    }
    setState(() {
      _searching = true;
      _searchError = null;
    });
    _t = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (!mounted || my != _seq) return;
        setState(() {
          _users = (r['users'] as List).cast<Map>();
          _groups = (r['groups'] as List).cast<Map>();
          _searching = false;
          _searched = true;
        });
      } catch (e) {
        if (!mounted || my != _seq) return;
        setState(() {
          _users = [];
          _groups = [];
          _searching = false;
          _searched = false;
          _searchError = errorText(e, 'Search failed. Try again.');
        });
      }
    });
  }

  void _pick(VoidCallback set) {
    _seq++;
    _t?.cancel();
    setState(() {
      set();
      _users = [];
      _groups = [];
      _searching = false;
      _searched = false;
      _searchError = null;
    });
  }

  Future<void> _share(Map<String, String> subject, String lvl, String? expiresAt, {bool fromSuggestion = false, String label = ''}) async {
    if (_sharing) return;
    widget.onError(null);
    setState(() => _sharing = true);
    try {
      final policy = (_needsApproval || _workHours) && !fromSuggestion
          ? {
              'downloadApproval': _needsApproval,
              if (_workHours) 'window': {'days': [1, 2, 3, 4, 5], 'start': '09:00', 'end': '18:00', 'timeZone': _zone.text.trim()},
            }
          : null;
      await Api.I.put('/documents/$_docId/access', {...subject, 'level': lvl, 'expiresAt': expiresAt, 'fromSuggestion': fromSuggestion, 'policy': ?policy});
      if (!mounted) return;
      toast(
        context,
        '${label.isEmpty ? 'Access' : label} can now ${lvl == 'VIEW'
            ? 'view (not download)'
            : lvl == 'READ'
            ? 'view and download'
            : lvl == 'EDIT'
            ? 'edit'
            : 'manage'} this document.',
      );
      setState(() {
        _target = null;
        _query.clear();
        _expires = '';
        _needsApproval = false;
        _workHours = false;
        _users = [];
        _groups = [];
        _searched = false;
        final id = subject['userId'] ?? subject['groupId'];
        _suggestions = _suggestions?.where((s) => s['id'] != id).toList();
      });
      await _load();
    } catch (e) {
      widget.onError(errorText(e));
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  /// Confirms the members who joined a group after it was shared (THREATS.md
  /// A19). Re-sends that grant exactly as it is (level, end date and its own
  /// conditions): the share form, and whatever is half-filled in it, is not
  /// involved.
  Future<void> _confirmPending(Map g) async {
    final s = g['subject'] as Map;
    final gid = s['id'] as String;
    if (_confirming.contains(gid)) return;
    widget.onError(null);
    setState(() => _confirming.add(gid));
    try {
      await Api.I.put('/documents/$_docId/access', {
        'groupId': gid,
        'level': g['level'],
        'expiresAt': g['expiresAt'],
        'fromSuggestion': false,
        if (g['policy'] != null) 'policy': g['policy'],
      });
      if (mounted) toast(context, 'Confirmed. Everyone in group ${s['name']} now has this access.');
      await _load();
    } catch (e) {
      widget.onError(errorText(e));
    } finally {
      if (mounted) setState(() => _confirming.remove(gid));
    }
  }

  Future<void> _revoke(Map g) async {
    final gid = g['id'] as String;
    if (_revoking.contains(gid)) return;
    final subject = g['subject'] as Map;
    final isGroup = subject['type'] == 'group';
    final ok = await showConfirm(
      context,
      isGroup ? 'Remove group ${subject['name']}’s access?' : 'Remove ${subject['name']}’s access?',
      isGroup
          ? 'Everyone who has it only through this group loses access on their next request.'
          : 'They lose access on their next request. Copies they already downloaded stay stamped with their name.',
      confirmLabel: 'Remove access',
      danger: true,
      icon: PhosphorIconsDuotone.userMinus,
    );
    if (!ok || !mounted) return;
    widget.onError(null);
    setState(() => _revoking.add(gid));
    try {
      final r = await Api.I.delete('/documents/$_docId/access/$gid');
      final name = subject['name'];
      final still = r is Map ? r['stillHas'] as String? : null;
      // Their own grant is gone, but a group grant may still cover them. Say so.
      if (mounted) {
        still != null
            ? toast(context, "Removed $name's own access, but they can still ${_levelWord(still)} it through a group. Remove that group's grant to cut them off.", tone: Tone.amber)
            : toast(context, 'Access removed for $name. It stops working on their next request.');
      }
      await _load();
    } catch (e) {
      widget.onError(errorText(e));
    } finally {
      if (mounted) setState(() => _revoking.remove(gid));
    }
  }

  Future<void> _loadSuggestions() async {
    if (_loadingSuggestions) return;
    setState(() => _loadingSuggestions = true);
    try {
      final r = await Api.I.get('/documents/$_docId/suggestions') as Map;
      if (mounted) setState(() => _suggestions = (r['suggestions'] as List).cast<Map>());
    } catch (e) {
      widget.onError(errorText(e));
    } finally {
      if (mounted) setState(() => _loadingSuggestions = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final isOwner = widget.doc['isOwner'] == true;
    final owner = widget.doc['owner'] as Map;
    final t = _target;
    final levels = _levels.where((l) => l.$1 == 'VIEW' || l.$1 == 'READ' || (!(t?.external ?? false) && (l.$1 == 'EDIT' || isOwner))).toList();
    final users = _users.where((u) => u['id'] != owner['id']).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TvCard(
          title: 'Share this document',
          icon: PhosphorIconsDuotone.userPlus,
          description: 'Access is granted to this one document only. Changes take effect immediately.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (t != null)
                Rise(
                  dy: 6,
                  child: Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: p.selectedBg,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: toneOf(Tone.brand, p.dark).ring),
                    ),
                    child: Row(
                      children: [
                        t.type == 'group' ? const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue, size: 32) : Avatar(t.label, size: 32),
                        gap12,
                        Expanded(
                          child: Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 6,
                            children: [
                              Text.rich(
                                TextSpan(
                                  style: ts(context, size: 13.5),
                                  children: [
                                    const TextSpan(text: 'Sharing with '),
                                    TextSpan(
                                      text: t.label,
                                      style: const TextStyle(fontWeight: FontWeight.w600),
                                    ),
                                  ],
                                ),
                              ),
                              if (t.external) const TvBadge('External', tone: Tone.amber),
                            ],
                          ),
                        ),
                        Btn('Change', size: BtnSize.sm, variant: BtnVariant.ghost, icon: PhosphorIconsDuotone.arrowsLeftRight, onPressed: _sharing ? null : () => setState(() => _target = null)),
                      ],
                    ),
                  ),
                )
              else ...[
                TextField(
                  controller: _query,
                  onChanged: _search,
                  textInputAction: TextInputAction.search,
                  decoration: fieldDeco(
                    hint: 'Type a name, email or group (2+ letters)',
                    icon: PhosphorIconsDuotone.magnifyingGlass,
                    suffix: _searching
                        ? const Padding(
                            padding: EdgeInsets.all(14),
                            child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                          )
                        : null,
                  ),
                ),
                if (_searchError != null) Rise(dy: 6, child: Padding(padding: const EdgeInsets.only(top: 8), child: TvAlert(_searchError!, title: 'Search failed'))),
                if (_searched && !_searching && _groups.isEmpty && users.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
                    child: Semantics(
                      liveRegion: true,
                      child: Row(
                        children: [
                          Ic(PhosphorIconsDuotone.fileMagnifyingGlass, size: 16, color: p.subtle),
                          gap8,
                          Expanded(child: Text('Nobody matches “${_query.text.trim()}”.', style: ts(context, size: 13, color: p.muted))),
                        ],
                      ),
                    ),
                  ),
                if (_groups.isNotEmpty || users.isNotEmpty) gap8,
                if (_groups.isNotEmpty || users.isNotEmpty)
                  Rise(
                    dy: 6,
                    child: Material(
                    // A Material, so each row's ripple shows on the dropdown.
                    color: p.raised,
                    clipBehavior: Clip.antiAlias,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                      side: BorderSide(color: p.border),
                    ),
                    elevation: 0,
                    child: Column(
                      children: [
                        for (final g in _groups)
                          ListTile(
                            dense: true,
                            leading: const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue, size: 32),
                            title: Text(g['name'] as String, style: ts(context, size: 14, w: FontWeight.w500)),
                            subtitle: Text('Group · ${g['members']} members', style: ts(context, size: 12, color: p.muted)),
                            onTap: () => _pick(() => _target = (type: 'group', id: g['id'] as String, label: 'group ${g['name']}', external: false)),
                          ),
                        for (final u in users)
                          ListTile(
                            dense: true,
                            leading: Avatar(u['displayName'] as String, size: 32),
                            title: Text(u['displayName'] as String, style: ts(context, size: 14, w: FontWeight.w500)),
                            subtitle: Text(
                              u['email'] as String,
                              overflow: TextOverflow.ellipsis,
                              style: ts(context, size: 12, color: p.muted),
                            ),
                            trailing: u['role'] == 'EXTERNAL' ? const TvBadge('External', tone: Tone.amber) : null,
                            onTap: () => _pick(() {
                              _target = (type: 'user', id: u['id'] as String, label: u['displayName'] as String, external: u['role'] == 'EXTERNAL');
                              // Externals start at View only: the file never leaves TrustVault (THREATS.md V10).
                              _level = u['role'] == 'EXTERNAL' ? 'VIEW' : 'READ';
                            }),
                          ),
                      ],
                    ),
                  ),
                  ),
              ],
              gap16,
              Semantics(
                header: true,
                child: Text(
                  'Access level',
                  style: ts(context, size: 13, w: FontWeight.w500, color: p.body),
                ),
              ),
              gap8,
              for (final l in levels)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ChoiceCard(icon: l.$4, title: l.$2, text: l.$3, selected: _level == l.$1, onTap: () => setState(() => _level = l.$1)),
                ),
              if (t?.external ?? false)
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(padding: const EdgeInsets.only(top: 1), child: Ic(PhosphorIconsDuotone.warning, size: 14, color: p.warning)),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text('External people get View only or Download, and it must end on a date. View only is suggested: the file never leaves TrustVault.', style: ts(context, size: 12, color: p.warning, height: 1.45)),
                    ),
                  ],
                ),
              gap12,
              FieldLabel(
                (t?.external ?? false) ? 'Expires on (required for external)' : 'Expires on (optional)',
                child: Press(
                  button: true,
                  semanticLabel: _expires.isEmpty ? 'Expires on: no end date. Choose a date' : 'Expires on $_expires. Change the date',
                  onTap: () async {
                    final now = DateTime.now();
                    final d = await showDatePicker(context: context, firstDate: now, lastDate: DateTime(now.year + 5), initialDate: now.add(const Duration(days: 30)));
                    if (d != null) setState(() => _expires = isoDay(d));
                  },
                  child: InputDecorator(
                    decoration: fieldDeco(
                      icon: PhosphorIconsDuotone.calendarBlank,
                      suffix: _expires.isEmpty ? null : IconButton(tooltip: 'Clear end date', constraints: const BoxConstraints(minWidth: kMinTap, minHeight: kMinTap), icon: Ic(PhosphorIconsBold.x, size: 14, color: p.muted), onPressed: () => setState(() => _expires = '')),
                    ),
                    child: Text(_expires.isEmpty ? 'No end date' : _expires, style: ts(context, size: 14, color: _expires.isEmpty ? p.subtle : null)),
                  ),
                ),
              ),
              gap8,
              // A Material, so the rows' ripple shows on the card.
              Material(
                type: MaterialType.transparency,
                child: Column(
                  children: [
                    CheckboxListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      checkboxShape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
                      activeColor: p.dark ? C.brand500 : C.brand600,
                      side: BorderSide(color: p.lineStrong, width: 1.5),
                      value: _needsApproval,
                      onChanged: (v) => setState(() => _needsApproval = v ?? false),
                      secondary: Ic(PhosphorIconsDuotone.sealCheck, size: 18, color: _needsApproval ? p.accent : p.subtle),
                      title: Text('Downloads need my approval', style: ts(context, size: 14, w: FontWeight.w500)),
                      subtitle: Text('They can read the details; each download waits for you.', style: ts(context, size: 12, color: p.muted)),
                    ),
                    CheckboxListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      checkboxShape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
                      activeColor: p.dark ? C.brand500 : C.brand600,
                      side: BorderSide(color: p.lineStrong, width: 1.5),
                      value: _workHours,
                      onChanged: (v) => setState(() => _workHours = v ?? false),
                      secondary: Ic(PhosphorIconsDuotone.calendarBlank, size: 18, color: _workHours ? p.accent : p.subtle),
                      title: Text('Only Mon–Fri 09:00–18:00', style: ts(context, size: 14, w: FontWeight.w500)),
                      subtitle: Text('Local time in the zone below, daylight saving included.', style: ts(context, size: 12, color: p.muted)),
                    ),
                  ],
                ),
              ),
              AnimatedSize(
                duration: Motion.of(context, Motion.base),
                curve: Motion.easeOut,
                alignment: Alignment.topCenter,
                child: _workHours
                    ? Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: TextField(controller: _zone, decoration: fieldDeco(hint: 'Time zone, e.g. Europe/London', icon: PhosphorIconsDuotone.globe)),
                      )
                    : const SizedBox(width: double.infinity),
              ),
              gap16,
              Btn(
                'Share',
                variant: BtnVariant.primary,
                size: BtnSize.lg,
                expand: true,
                icon: PhosphorIconsDuotone.shareNetwork,
                loading: _sharing,
                onPressed: t == null || _sharing || (t.external && _expires.isEmpty)
                    ? null
                    : () => _share(
                        t.type == 'user' ? {'userId': t.id} : {'groupId': t.id},
                        _level,
                        _expires.isEmpty ? null : DateTime.parse('${_expires}T23:59:59').toUtc().toIso8601String(),
                        label: t.label,
                      ),
              ),
            ],
          ),
        ),
        gap16,
        TvCard(
          title: 'Who has access',
          icon: PhosphorIconsDuotone.usersFour,
          actions: _grants == null ? null : TvBadge('${_grants!.length + 1} with access'),
          padded: false,
          child: _grants == null
              ? (_loadError != null
                    ? Padding(
                        padding: const EdgeInsets.all(14),
                        child: ErrorState(compact: true, title: 'Could not load who has access', message: _loadError, onRetry: _load),
                      )
                    : const SkeletonRows(rows: 3))
              : RowList(
                  children: [
                    _person(
                      context,
                      p,
                      Avatar(owner['displayName'] as String),
                      '${owner['displayName']}${isOwner ? ' (you)' : ''}',
                      owner['email'] as String,
                      const TvBadge('Owner', tone: Tone.violet, icon: PhosphorIconsDuotone.crown),
                      null,
                    ),
                    for (final (i, g) in _grants!.indexed)
                      Rise(key: ValueKey(g['id']), delay: 40 * (i + 1).clamp(0, 8), dy: 6, child: _grantRow(context, p, g, isOwner)),
                    if (_grants!.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Row(
                          children: [
                            Ic(PhosphorIconsDuotone.lockKey, size: 16, color: p.subtle),
                            gap8,
                            Expanded(child: Text('Only the owner can open this document.', style: ts(context, size: 13, color: p.muted))),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        gap16,
        TvCard(
          title: 'Suggested people',
          icon: PhosphorIconsDuotone.sparkle,
          description: 'Based on who you shared similar documents with. Never grants access by itself.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_suggestions == null)
                Text('You confirm each one, and both the suggestion and your decision are recorded.', style: ts(context, size: 13, color: p.muted))
              else if (_suggestions!.isEmpty)
                Row(
                  children: [
                    Ic(PhosphorIconsDuotone.sparkle, size: 16, color: p.subtle),
                    gap8,
                    Expanded(child: Text('No suggestions for this document.', style: ts(context, size: 13, color: p.muted))),
                  ],
                )
              else
                for (final (i, s) in _suggestions!.indexed)
                  Rise(
                    key: ValueKey('s-${s['type']}-${s['id']}'),
                    delay: 40 * i.clamp(0, 8),
                    dy: 6,
                    child: Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: p.divider),
                    ),
                    child: Row(
                      children: [
                        s['type'] == 'group' ? const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue, size: 32) : Avatar(s['name'] as String, size: 32),
                        gap12,
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(s['type'] == 'group' ? 'Group: ${s['name']}' : '${s['name']}', style: ts(context, size: 13.5, w: FontWeight.w600)),
                              if (s['type'] == 'user') Text(s['detail'] as String, style: ts(context, size: 12, color: p.muted)),
                              Text(s['why'] as String, style: ts(context, size: 12, color: p.muted)),
                            ],
                          ),
                        ),
                        Btn(
                          'Share ${accessLabel[s['level']]}',
                          size: BtnSize.sm,
                          icon: PhosphorIconsDuotone.userPlus,
                          onPressed: _sharing
                              ? null
                              : () => _share(
                            s['type'] == 'user' ? {'userId': s['id'] as String} : {'groupId': s['id'] as String},
                            s['level'] as String,
                            null,
                            fromSuggestion: true,
                            label: s['name'] as String,
                          ),
                        ),
                      ],
                    ),
                  ),
                  ),
              gap8,
              Align(
                alignment: Alignment.centerLeft,
                child: Btn(
                  _suggestions == null ? 'Show suggestions' : 'Refresh',
                  size: BtnSize.sm,
                  variant: BtnVariant.soft,
                  icon: PhosphorIconsDuotone.sparkle,
                  loading: _loadingSuggestions,
                  onPressed: _loadingSuggestions ? null : _loadSuggestions,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _grantRow(BuildContext context, Pal p, Map g, bool isOwner) {
    final s = g['subject'] as Map;
    final isGroup = s['type'] == 'group';
    final sub = StringBuffer();
    if (!isGroup) sub.write('${s['email']} · ');
    sub.write('granted by ${g['grantedBy']}');
    if (g['expiresAt'] != null) sub.write(' · ${g['expired'] == true ? 'expired' : 'expires'} ${formatDate(g['expiresAt'] as String?)}');
    final level = g['level'] as String;
    return _person(
      context,
      p,
      isGroup ? const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue) : Avatar(s['name'] as String),
      isGroup ? '${s['name']} · group of ${s['members']}' : s['name'] as String,
      sub.toString(),
      TvBadge(accessLabel[level] ?? level, tone: accessTone[level] ?? Tone.neutral, dot: true),
      (isOwner || level != 'MANAGE')
          ? (_revoking.contains(g['id'])
                ? const SizedBox(
                    width: kMinTap,
                    height: kMinTap,
                    child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
                  )
                : IconBtn(PhosphorIconsDuotone.trash, tooltip: 'Remove access for ${s['name']}', danger: true, onPressed: () => _revoke(g)))
          : null,
      extra: [
        if (!isGroup && s['role'] == 'EXTERNAL') const TvBadge('External', tone: Tone.amber),
        // People added to the group after it was shared wait for the owner (THREATS.md A19).
        if (isGroup && ((s['pending'] as int?) ?? 0) > 0)
          Press(
            button: true,
            semanticLabel: '${s['pending']} people waiting in group ${s['name']}. Confirm their access',
            onTap: _confirming.contains(s['id']) ? null : () => _confirmPending(g),
            child: _confirming.contains(s['id'])
                ? const TvBadge('Confirming…', tone: Tone.amber, icon: PhosphorIconsDuotone.userPlus)
                : TvBadge('${s['pending']} waiting · tap to confirm', tone: Tone.amber, icon: PhosphorIconsDuotone.userPlus),
          ),
        if (!isGroup && s['active'] == false) const TvBadge('Inactive', tone: Tone.red),
        ..._conditionBadges(g['policy'] as Map?),
      ],
    );
  }

  Widget _person(BuildContext context, Pal p, Widget lead, String title, String sub, Widget badge, Widget? action, {List<Widget> extra = const []}) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
    child: Row(
      children: [
        lead,
        gap12,
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 6,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(title, style: ts(context, size: 13.5, w: FontWeight.w600)),
                  ...extra,
                ],
              ),
              Text(
                sub,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: ts(context, size: 12, color: p.muted),
              ),
            ],
          ),
        ),
        gap8,
        badge,
        if (action != null) action else const SizedBox(width: 8),
      ],
    ),
  );
}

/* ---------------------------------------------------------------- history */

class _History extends StatefulWidget {
  const _History({required this.docId});
  final String docId;
  @override
  State<_History> createState() => _HistoryState();
}

class _HistoryState extends State<_History> {
  List<Map>? _events;
  /// A failed load says so: on a security screen an error must never read
  /// as "nothing happened".
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/${widget.docId}/history') as Map;
      if (mounted) {
        setState(() {
          _events = (r['events'] as List).cast<Map>();
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not load the history.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final ev = _events;
    return TvCard(
      title: 'History',
      icon: PhosphorIconsDuotone.clockCounterClockwise,
      description: 'Everything that happened to this document, including refused attempts.',
      padded: ev == null || ev.isEmpty ? false : true,
      child: ev == null && _error != null
          ? ErrorState(title: 'Could not load the history', message: _error, onRetry: _load)
          : ev == null
          ? const SkeletonRows(rows: 5)
          : ev.isEmpty
          ? const EmptyState(icon: PhosphorIconsDuotone.clockCounterClockwise, title: 'No activity yet', body: 'Views, downloads, shares and refused attempts will show here.')
          : Column(
              children: [
                for (var i = 0; i < ev.length; i++)
                  Rise(
                    key: ValueKey('e-${ev[i]['seq']}'),
                    delay: 40 * i.clamp(0, 8),
                    dy: 6,
                    child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Column(
                          children: [
                            ActionIcon(ev[i]['action'] as String, ev[i]['outcome'] as String),
                            if (i < ev.length - 1)
                              Expanded(
                                child: Container(width: 1.2, margin: const EdgeInsets.symmetric(vertical: 4), color: p.border),
                              ),
                          ],
                        ),
                        gap12,
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.only(bottom: 16, top: 2),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Wrap(
                                  spacing: 6,
                                  crossAxisAlignment: WrapCrossAlignment.center,
                                  children: [
                                    Text(actionMeta(ev[i]['action'] as String).label, style: ts(context, size: 13.5, w: FontWeight.w600)),
                                    if (ev[i]['outcome'] != 'ALLOWED') TvBadge(outcomeLabel(ev[i]['outcome'] as String), tone: outcomeTone[ev[i]['outcome']] ?? Tone.neutral),
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  '${ev[i]['actorEmail'] ?? 'system'} · ${relativeTime(ev[i]['occurredAt'] as String?)}${ev[i]['reason'] != null ? ' · ${(ev[i]['reason'] as String).replaceAll('_', ' ')}' : ''}',
                                  style: ts(context, size: 12, color: p.muted),
                                ),
                                if (_sanitizedFrom(ev[i]['details']) case final note?)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 2),
                                    child: Text(note, style: ts(context, size: 12, color: p.muted, height: 1.4)),
                                  ),
                              ],
                            ),
                          ),
                        ),
                        Text(
                          '#${ev[i]['seq']}',
                          style: TextStyle(fontFamily: C.mono, fontSize: 11, color: p.subtle),
                        ),
                      ],
                    ),
                  ),
                  ),
              ],
            ),
    );
  }
}

/* ---------------------------------------------------------- owner actions */

class _OwnerActions extends StatefulWidget {
  const _OwnerActions({required this.doc, required this.busy, required this.onTrash, required this.onRestore, required this.onPurge, required this.onTransfer, required this.onMove});
  final Map doc;
  /// An action on the document is running; every button waits for it.
  final bool busy;
  final VoidCallback onTrash;
  final VoidCallback onRestore;
  final VoidCallback onPurge;
  final ValueChanged<String> onTransfer;
  final ValueChanged<String?> onMove;
  @override
  State<_OwnerActions> createState() => _OwnerActionsState();
}

class _OwnerActionsState extends State<_OwnerActions> {
  bool _confirmPurge = false;
  bool _confirmTrash = false;
  List<Map> _folders = [];
  List<Map> _owners = [];
  Timer? _t;
  int _seq = 0;
  bool _searching = false;
  bool _searched = false;
  String? _searchError;
  String _ownerQuery = '';
  /// Which button started the running action, so only it spins.
  String? _pressed;

  @override
  void initState() {
    super.initState();
    Api.I
        .get('/folders')
        .then((r) {
          if (mounted) setState(() => _folders = ((r as Map)['folders'] as List).cast<Map>());
        })
        .catchError((_) {});
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  void _searchOwners(String q) {
    _t?.cancel();
    final my = ++_seq;
    _ownerQuery = q.trim();
    if (q.trim().length < 2) {
      setState(() {
        _owners = [];
        _searching = false;
        _searched = false;
        _searchError = null;
      });
      return;
    }
    setState(() {
      _searching = true;
      _searchError = null;
    });
    _t = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (!mounted || my != _seq) return;
        setState(() {
          _owners = (r['users'] as List).cast<Map>().where((u) => u['role'] == 'OWNER').toList();
          _searching = false;
          _searched = true;
        });
      } catch (e) {
        if (!mounted || my != _seq) return;
        setState(() {
          _owners = [];
          _searching = false;
          _searched = false;
          _searchError = errorText(e, 'Search failed. Try again.');
        });
      }
    });
  }

  void _run(String key, VoidCallback action) {
    if (widget.busy) return;
    setState(() => _pressed = key);
    action();
  }

  Future<void> _transfer(Map o) async {
    if (widget.busy) return;
    final ok = await showConfirm(
      context,
      'Transfer “${widget.doc['title']}” to ${o['displayName']}?',
      'They become the owner with full control. You lose access unless they share it back. This can’t be undone from your side.',
      confirmLabel: 'Transfer',
      danger: true,
      icon: PhosphorIconsDuotone.arrowsLeftRight,
    );
    if (!ok || !mounted) return;
    _run('transfer:${o['id']}', () => widget.onTransfer(o['id'] as String));
  }

  bool _spins(String key) => widget.busy && _pressed == key;

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    if (widget.doc['status'] == 'DELETED') {
      return TvCard(
        title: 'In the trash',
        icon: PhosphorIconsDuotone.trash,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Only you can see it. It is removed permanently after the retention period.', style: ts(context, size: 13, color: p.muted, height: 1.5)),
            gap16,
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                Btn('Restore', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.arrowCounterClockwise, loading: _spins('restore'), onPressed: widget.busy ? null : () => _run('restore', widget.onRestore)),
                if (_confirmPurge) ...[
                  Btn('Yes, delete forever', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.fire, loading: _spins('purge'), onPressed: widget.busy ? null : () => _run('purge', widget.onPurge)),
                  Btn('Cancel', variant: BtnVariant.ghost, icon: PhosphorIconsBold.x, onPressed: widget.busy ? null : () => setState(() => _confirmPurge = false)),
                ] else
                  Btn('Delete permanently', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, onPressed: widget.busy ? null : () => setState(() => _confirmPurge = true)),
              ],
            ),
          ],
        ),
      );
    }
    final folder = widget.doc['folder'] as Map?;
    final red = toneOf(Tone.red, p.dark);
    return TvCard(
      title: 'Owner actions',
      icon: PhosphorIconsDuotone.crown,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_folders.isNotEmpty) ...[
            FieldLabel(
              'Folder',
              child: DropdownButtonFormField<String>(
                // Its value must be one of the items: a folder missing from
                // the list (deleted elsewhere) reads as "No folder".
                key: ValueKey('folder-${folder?['id']}-${_folders.length}'),
                initialValue: _folders.any((f) => f['id'] == folder?['id']) ? folder!['id'] as String : '',
                decoration: fieldDeco(icon: PhosphorIconsDuotone.folderSimple),
                items: [
                  const DropdownMenuItem(value: '', child: Text('No folder')),
                  for (final f in _folders) DropdownMenuItem(value: f['id'] as String, child: Text(f['name'] as String)),
                ],
                onChanged: widget.busy ? null : (v) => widget.onMove((v == null || v.isEmpty) ? null : v),
              ),
            ),
            gap16,
          ],
          FieldLabel(
            'Transfer ownership',
            hint: 'The new owner gets full control. You keep no access unless they share it back.',
            child: TextField(
              onChanged: _searchOwners,
              textInputAction: TextInputAction.search,
              decoration: fieldDeco(
                hint: 'Search document owners',
                icon: PhosphorIconsDuotone.arrowsLeftRight,
                suffix: _searching
                    ? const Padding(
                        padding: EdgeInsets.all(14),
                        child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                      )
                    : null,
              ),
            ),
          ),
          if (_searchError != null) Rise(dy: 6, child: Padding(padding: const EdgeInsets.only(top: 8), child: TvAlert(_searchError!, title: 'Search failed'))),
          if (_searched && !_searching && _owners.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
              child: Semantics(
                liveRegion: true,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(padding: const EdgeInsets.only(top: 1), child: Ic(PhosphorIconsDuotone.fileMagnifyingGlass, size: 16, color: p.subtle)),
                    gap8,
                    Expanded(
                      child: Text('No document owner matches “$_ownerQuery”. Only people with the Owner role can take over a document.', style: ts(context, size: 13, color: p.muted, height: 1.4)),
                    ),
                  ],
                ),
              ),
            ),
          for (final (i, o) in _owners.indexed)
            Rise(
              key: ValueKey('o-${o['id']}'),
              delay: 40 * i.clamp(0, 8),
              dy: 6,
              child: Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.divider),
              ),
              child: Row(
                children: [
                  Avatar(o['displayName'] as String, size: 32),
                  gap12,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(o['displayName'] as String, style: ts(context, size: 13.5, w: FontWeight.w500)),
                        Text(
                          o['email'] as String,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, size: 12, color: p.muted),
                        ),
                      ],
                    ),
                  ),
                  Btn('Transfer', size: BtnSize.sm, icon: PhosphorIconsDuotone.arrowsLeftRight, loading: _spins('transfer:${o['id']}'), onPressed: widget.busy ? null : () => _transfer(o)),
                ],
              ),
            ),
            ),
          gap16,
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: red.bg,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: red.ring),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Ic(PhosphorIconsDuotone.warningOctagon, size: 18, color: red.fg),
                    gap8,
                    Semantics(
                      header: true,
                      child: Text(
                        'Danger zone',
                        style: ts(context, size: 14, w: FontWeight.w600, color: red.fg),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  "Moving to the trash removes everyone else's access at once. You can restore it later.",
                  style: ts(context, size: 12, color: red.fg, height: 1.45),
                ),
                gap12,
                AnimatedSwitcher(
                  duration: Motion.of(context, Motion.base),
                  child: _confirmTrash
                      ? Wrap(
                          key: const ValueKey('confirm'),
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            Btn('Yes, move to trash', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, loading: _spins('trash'), onPressed: widget.busy ? null : () => _run('trash', widget.onTrash)),
                            Btn('Cancel', variant: BtnVariant.ghost, icon: PhosphorIconsBold.x, onPressed: widget.busy ? null : () => setState(() => _confirmTrash = false)),
                          ],
                        )
                      : Btn(key: const ValueKey('ask'), 'Move to trash', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, onPressed: widget.busy ? null : () => setState(() => _confirmTrash = true)),
                ),
              ],
            ),
          ),
        ],
      ),
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
