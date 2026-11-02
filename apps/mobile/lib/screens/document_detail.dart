import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/theme.dart';
import '../widgets/audit_ui.dart';
import '../widgets/files.dart';
import '../widgets/ui.dart';
import 'shell.dart';

const _rank = {'NONE': 0, 'READ': 1, 'EDIT': 2, 'MANAGE': 3, 'OWNER': 4};

class DocumentDetailScreen extends StatefulWidget {
  const DocumentDetailScreen({super.key, required this.id});
  final String id;
  @override
  State<DocumentDetailScreen> createState() => _DocumentDetailScreenState();
}

class _DocumentDetailScreenState extends State<DocumentDetailScreen> {
  Map? _doc;
  bool _notFound = false;
  String? _error;
  String _tab = 'overview';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await Api.I.get('/documents/${widget.id}') as Map;
      if (mounted) setState(() => _doc = d);
    } on ApiError catch (e) {
      if (!mounted) return;
      if (e.status == 404) {
        setState(() => _notFound = true);
      } else {
        setState(() => _error = e.message);
      }
    }
  }

  Future<void> _act(Future<void> Function() fn, String success, {VoidCallback? after}) async {
    setState(() => _error = null);
    try {
      await fn();
      if (!mounted) return;
      toast(context, success);
      if (after != null) {
        after();
      } else {
        await _load();
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
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
                Expanded(child: _body(context, p)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _body(BuildContext context, Pal p) {
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
            TvAlert(_error!)
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
                      current['quarantine'] != null
                          ? const Btn('Download blocked', icon: PhosphorIconsDuotone.prohibit, expand: true, onPressed: null)
                          : Btn(
                              'Download  ·  ${current['fileName']}',
                              variant: BtnVariant.primary,
                              size: BtnSize.lg,
                              expand: true,
                              icon: PhosphorIconsDuotone.downloadSimple,
                              onPressed: () => downloadAndOpen(context, '/documents/${doc['id']}/download', fallbackName: current['fileName'] as String),
                            ),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
        if (_error != null) ...[gap16, TvAlert(_error!, onDismiss: () => setState(() => _error = null))],
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
        if (_tab == 'overview') ...[
          _Details(doc: doc, canEdit: level >= _rank['EDIT']! && !trashed, onSave: (patch) => _act(() => Api.I.patch('/documents/${doc['id']}', patch), 'Details saved')),
          gap16,
          _ProtectionCard(isOwner: isOwner),
        ],
        if (_tab == 'versions') _Versions(doc: doc, canUpload: level >= _rank['EDIT']! && !trashed, onUploaded: () => _act(() async {}, 'New version uploaded'), onError: _setError),
        if (_tab == 'access') _AccessPanel(doc: doc, onError: _setError),
        if (_tab == 'history') _History(docId: doc['id'] as String),
        gap16,
        _AboutCard(doc: doc, canManage: canManage),
        if (isOwner) ...[
          gap16,
          _OwnerActions(
            doc: doc,
            onTrash: () => _act(() => Api.I.post('/documents/${doc['id']}/trash'), 'Moved to the trash. Nobody else can reach it now.'),
            onRestore: () => _act(() => Api.I.post('/documents/${doc['id']}/restore'), 'Restored'),
            onPurge: () => _act(() => Api.I.delete('/documents/${doc['id']}'), 'Deleted permanently', after: () => Navigator.pop(context)),
            onTransfer: (id) => _act(() => Api.I.post('/documents/${doc['id']}/transfer', {'newOwnerId': id}), 'Ownership transferred', after: () => Navigator.pop(context)),
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
            child: Ic(icon, size: 17, color: p.faint),
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
                  child: Ic(PhosphorIconsDuotone.hash, size: 17, color: p.faint),
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
                        decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(10)),
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
              decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(12)),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Ic(PhosphorIconsDuotone.eye, size: 16, color: p.muted),
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
          for (final (icon, title, text, tone) in items)
            Container(
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
  final Future<void> Function(Map<String, dynamic>) onSave;
  @override
  State<_Details> createState() => _DetailsState();
}

class _DetailsState extends State<_Details> {
  bool _editing = false;
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
    if (old.doc != widget.doc) _reset();
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final desc = widget.doc['description'] as String?;
    return TvCard(
      title: 'Details',
      icon: PhosphorIconsDuotone.pencilSimple,
      actions: widget.canEdit && !_editing ? Btn('Edit', size: BtnSize.sm, icon: PhosphorIconsDuotone.pencilSimple, onPressed: () => setState(() => _editing = true)) : null,
      child: _editing
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FieldLabel(
                  'Title',
                  child: TextField(
                    controller: _title,
                    maxLength: 200,
                    decoration: fieldDeco().copyWith(counterText: ''),
                  ),
                ),
                gap12,
                FieldLabel(
                  'Category',
                  child: TextField(
                    controller: _category,
                    maxLength: 60,
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
                    decoration: fieldDeco().copyWith(counterText: ''),
                  ),
                ),
                gap16,
                Row(
                  children: [
                    Btn(
                      'Save',
                      variant: BtnVariant.primary,
                      icon: PhosphorIconsBold.check,
                      onPressed: () async {
                        await widget.onSave({'title': _title.text.trim(), 'category': _category.text.trim(), 'description': _desc.text.trim().isEmpty ? null : _desc.text.trim()});
                        if (mounted) setState(() => _editing = false);
                      },
                    ),
                    gap8,
                    Btn(
                      'Cancel',
                      variant: BtnVariant.ghost,
                      onPressed: () => setState(() {
                        _editing = false;
                        _reset();
                      }),
                    ),
                  ],
                ),
              ],
            )
          : (desc == null || desc.isEmpty)
          ? Text(
              'No description.',
              style: ts(context, size: 14, color: p.faint).copyWith(fontStyle: FontStyle.italic),
            )
          : Text(desc, style: ts(context, size: 14, color: p.body, height: 1.55)),
    );
  }
}

/* --------------------------------------------------------------- versions */

class _Versions extends StatefulWidget {
  const _Versions({required this.doc, required this.canUpload, required this.onUploaded, required this.onError});
  final Map doc;
  final bool canUpload;
  final VoidCallback onUploaded;
  final ValueChanged<String?> onError;
  @override
  State<_Versions> createState() => _VersionsState();
}

class _VersionsState extends State<_Versions> {
  bool _busy = false;

  Future<void> _upload() async {
    final f = await FilePicker.pickFile();
    if (f == null) return;
    setState(() => _busy = true);
    try {
      await Api.I.upload('/documents/${widget.doc['id']}/versions', bytes: await f.readAsBytes(), fileName: f.name);
      widget.onUploaded();
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
            IntrinsicHeight(
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
          if (widget.canUpload) ...[
            gap4,
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: p.dark ? Colors.white.withValues(alpha: .15) : C.slate300),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Upload a new version', style: ts(context, size: 13.5, w: FontWeight.w600)),
                  Text('Scanned for malware and encrypted before it is stored.', style: ts(context, size: 12, color: p.muted)),
                  gap12,
                  Btn(_busy ? 'Uploading…' : 'Choose file and upload', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.cloudArrowUp, loading: _busy, expand: true, onPressed: _upload),
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
    final border = q != null
        ? (p.dark ? C.red500.withValues(alpha: .3) : C.red200)
        : current
        ? (p.dark ? C.brand400.withValues(alpha: .25) : C.brand200)
        : p.divider;
    final bg = q != null
        ? (p.dark ? C.red500.withValues(alpha: .05) : C.red50.withValues(alpha: .5))
        : current
        ? (p.dark ? C.brand500.withValues(alpha: .05) : C.brand50.withValues(alpha: .4))
        : Colors.transparent;
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
                  : Btn(
                      'Download',
                      size: BtnSize.sm,
                      icon: PhosphorIconsDuotone.downloadSimple,
                      onPressed: () => downloadAndOpen(context, '/documents/${widget.doc['id']}/versions/${v['versionNo']}/download', fallbackName: v['fileName'] as String),
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
                  Ic(PhosphorIconsDuotone.biohazard, size: 16, color: p.dark ? C.red300 : C.red700),
                  gap8,
                  Expanded(
                    child: Text(
                      'Quarantined ${formatDate(q['foundAt'] as String?)}: the malware scanner found ${q['signature']}',
                      style: ts(context, size: 12, w: FontWeight.w500, color: p.dark ? C.red300 : C.red700),
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
  ('READ', 'Read', 'View and download', PhosphorIconsDuotone.eye),
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
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/documents/$_docId/access') as Map;
      if (mounted) setState(() => _grants = (r['grants'] as List).cast<Map>());
    } catch (e) {
      widget.onError(errorText(e));
    }
  }

  void _search(String q) {
    _t?.cancel();
    if (q.trim().length < 2) {
      setState(() {
        _users = [];
        _groups = [];
      });
      return;
    }
    _t = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (mounted) {
          setState(() {
            _users = (r['users'] as List).cast<Map>();
            _groups = (r['groups'] as List).cast<Map>();
          });
        }
      } catch (_) {}
    });
  }

  Future<void> _share(Map<String, String> subject, String lvl, String? expiresAt, {bool fromSuggestion = false, String label = ''}) async {
    widget.onError(null);
    try {
      await Api.I.put('/documents/$_docId/access', {...subject, 'level': lvl, 'expiresAt': expiresAt, 'fromSuggestion': fromSuggestion});
      if (!mounted) return;
      toast(
        context,
        '${label.isEmpty ? 'Access' : label} can now ${lvl == 'READ'
            ? 'read'
            : lvl == 'EDIT'
            ? 'edit'
            : 'manage'} this document.',
      );
      setState(() {
        _target = null;
        _query.clear();
        _expires = '';
        _users = [];
        _groups = [];
        final id = subject['userId'] ?? subject['groupId'];
        _suggestions = _suggestions?.where((s) => s['id'] != id).toList();
      });
      await _load();
    } catch (e) {
      widget.onError(errorText(e));
    }
  }

  Future<void> _revoke(Map g) async {
    widget.onError(null);
    try {
      await Api.I.delete('/documents/$_docId/access/${g['id']}');
      if (mounted) toast(context, 'Access removed for ${(g['subject'] as Map)['name']}. It stops working on their next request.');
      await _load();
    } catch (e) {
      widget.onError(errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final isOwner = widget.doc['isOwner'] == true;
    final owner = widget.doc['owner'] as Map;
    final t = _target;
    final levels = _levels.where((l) => l.$1 == 'READ' || (!(t?.external ?? false) && (l.$1 == 'EDIT' || isOwner))).toList();
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
                      border: Border.all(color: p.dark ? C.brand400.withValues(alpha: .25) : C.brand200),
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
                        Btn('Change', size: BtnSize.sm, variant: BtnVariant.ghost, onPressed: () => setState(() => _target = null)),
                      ],
                    ),
                  ),
                )
              else ...[
                TextField(
                  controller: _query,
                  onChanged: _search,
                  decoration: fieldDeco(hint: 'Type a name, email or group (2+ letters)', icon: PhosphorIconsDuotone.magnifyingGlass),
                ),
                if (_groups.isNotEmpty || users.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    decoration: BoxDecoration(
                      color: p.raised,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: p.border),
                      boxShadow: p.dark ? null : C.lift,
                    ),
                    child: Column(
                      children: [
                        for (final g in _groups)
                          ListTile(
                            dense: true,
                            leading: const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue, size: 32),
                            title: Text(g['name'] as String, style: ts(context, size: 14, w: FontWeight.w500)),
                            subtitle: Text('Group · ${g['members']} members', style: ts(context, size: 12, color: p.muted)),
                            onTap: () => setState(() {
                              _target = (type: 'group', id: g['id'] as String, label: 'group ${g['name']}', external: false);
                              _users = [];
                              _groups = [];
                            }),
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
                            onTap: () => setState(() {
                              _target = (type: 'user', id: u['id'] as String, label: u['displayName'] as String, external: u['role'] == 'EXTERNAL');
                              _level = 'READ';
                              _users = [];
                              _groups = [];
                            }),
                          ),
                      ],
                    ),
                  ),
              ],
              gap16,
              Text(
                'Access level',
                style: ts(context, size: 13, w: FontWeight.w500, color: p.body),
              ),
              gap8,
              for (final l in levels)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: ChoiceCard(icon: l.$4, title: l.$2, text: l.$3, selected: _level == l.$1, onTap: () => setState(() => _level = l.$1)),
                ),
              if (t?.external ?? false) Text('External people can only be given Read access, and it must end on a date.', style: ts(context, size: 12, color: p.dark ? C.amber300 : C.amber700)),
              gap12,
              FieldLabel(
                (t?.external ?? false) ? 'Expires on (required for external)' : 'Expires on (optional)',
                child: Press(
                  onTap: () async {
                    final now = DateTime.now();
                    final d = await showDatePicker(context: context, firstDate: now, lastDate: DateTime(now.year + 5), initialDate: now.add(const Duration(days: 30)));
                    if (d != null) setState(() => _expires = isoDay(d));
                  },
                  child: InputDecorator(
                    decoration: fieldDeco(
                      icon: PhosphorIconsDuotone.calendarBlank,
                      suffix: _expires.isEmpty ? null : IconButton(icon: const Ic(PhosphorIconsBold.x, size: 14), onPressed: () => setState(() => _expires = '')),
                    ),
                    child: Text(_expires.isEmpty ? 'No end date' : _expires, style: ts(context, size: 14, color: _expires.isEmpty ? C.slate400 : null)),
                  ),
                ),
              ),
              gap16,
              Btn(
                'Share',
                variant: BtnVariant.primary,
                size: BtnSize.lg,
                expand: true,
                icon: PhosphorIconsDuotone.shareNetwork,
                onPressed: t == null || (t.external && _expires.isEmpty)
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
              ? const SkeletonRows(rows: 3)
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
                    for (final g in _grants!) _grantRow(context, p, g, isOwner),
                    if (_grants!.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text('Only the owner can open this document.', style: ts(context, size: 13, color: p.muted)),
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
                Text('No suggestions for this document.', style: ts(context, size: 13, color: p.muted))
              else
                for (final s in _suggestions!)
                  Container(
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
                          onPressed: () => _share(
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
              gap8,
              Align(
                alignment: Alignment.centerLeft,
                child: Btn(
                  _suggestions == null ? 'Show suggestions' : 'Refresh',
                  size: BtnSize.sm,
                  variant: BtnVariant.soft,
                  icon: PhosphorIconsDuotone.sparkle,
                  onPressed: () async {
                    try {
                      final r = await Api.I.get('/documents/$_docId/suggestions') as Map;
                      if (mounted) setState(() => _suggestions = (r['suggestions'] as List).cast<Map>());
                    } catch (e) {
                      widget.onError(errorText(e));
                    }
                  },
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
      (isOwner || level != 'MANAGE') ? IconBtn(PhosphorIconsDuotone.trash, tooltip: 'Remove access for ${s['name']}', danger: true, onPressed: () => _revoke(g)) : null,
      extra: [
        if (!isGroup && s['role'] == 'EXTERNAL') const TvBadge('External', tone: Tone.amber),
        if (!isGroup && s['active'] == false) const TvBadge('Inactive', tone: Tone.red),
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
  @override
  void initState() {
    super.initState();
    Api.I
        .get('/documents/${widget.docId}/history')
        .then((r) {
          if (mounted) setState(() => _events = ((r as Map)['events'] as List).cast<Map>());
        })
        .catchError((_) {
          if (mounted) setState(() => _events = []);
        });
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
      child: ev == null
          ? const SkeletonRows(rows: 5)
          : ev.isEmpty
          ? const EmptyState(icon: PhosphorIconsDuotone.clockCounterClockwise, title: 'No activity yet')
          : Column(
              children: [
                for (var i = 0; i < ev.length; i++)
                  IntrinsicHeight(
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
                              ],
                            ),
                          ),
                        ),
                        Text(
                          '#${ev[i]['seq']}',
                          style: TextStyle(fontFamily: C.mono, fontSize: 11, color: p.faint),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}

/* ---------------------------------------------------------- owner actions */

class _OwnerActions extends StatefulWidget {
  const _OwnerActions({required this.doc, required this.onTrash, required this.onRestore, required this.onPurge, required this.onTransfer, required this.onMove});
  final Map doc;
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
    if (q.trim().length < 2) {
      setState(() => _owners = []);
      return;
    }
    _t = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (mounted) setState(() => _owners = (r['users'] as List).cast<Map>().where((u) => u['role'] == 'OWNER').toList());
      } catch (_) {}
    });
  }

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
                Btn('Restore', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.arrowCounterClockwise, onPressed: widget.onRestore),
                _confirmPurge
                    ? Btn('Yes, delete forever', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.fire, onPressed: widget.onPurge)
                    : Btn('Delete permanently', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, onPressed: () => setState(() => _confirmPurge = true)),
              ],
            ),
          ],
        ),
      );
    }
    final folder = widget.doc['folder'] as Map?;
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
                initialValue: (folder?['id'] as String?) ?? '',
                decoration: fieldDeco(icon: PhosphorIconsDuotone.folderSimple),
                items: [
                  const DropdownMenuItem(value: '', child: Text('No folder')),
                  for (final f in _folders) DropdownMenuItem(value: f['id'] as String, child: Text(f['name'] as String)),
                ],
                onChanged: (v) => widget.onMove((v == null || v.isEmpty) ? null : v),
              ),
            ),
            gap16,
          ],
          FieldLabel(
            'Transfer ownership',
            hint: 'The new owner gets full control. You keep no access unless they share it back.',
            child: TextField(
              onChanged: _searchOwners,
              decoration: fieldDeco(hint: 'Search document owners', icon: PhosphorIconsDuotone.arrowsLeftRight),
            ),
          ),
          for (final o in _owners)
            Container(
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
                  Btn('Transfer', size: BtnSize.sm, onPressed: () => widget.onTransfer(o['id'] as String)),
                ],
              ),
            ),
          gap16,
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: p.dark ? C.red500.withValues(alpha: .05) : C.red50.withValues(alpha: .5),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.dark ? C.red500.withValues(alpha: .25) : C.red200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Ic(PhosphorIconsDuotone.warning, size: 18, color: p.dark ? C.red300 : C.red700),
                    gap8,
                    Text(
                      'Danger zone',
                      style: ts(context, size: 14, w: FontWeight.w600, color: p.dark ? C.red300 : C.red700),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  "Moving to the trash removes everyone else's access at once. You can restore it later.",
                  style: ts(context, size: 12, color: (p.dark ? C.red300 : C.red700).withValues(alpha: .8), height: 1.45),
                ),
                gap12,
                _confirmTrash
                    ? Wrap(
                        spacing: 8,
                        children: [
                          Btn('Yes, move to trash', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, onPressed: widget.onTrash),
                          Btn('Cancel', variant: BtnVariant.ghost, onPressed: () => setState(() => _confirmTrash = false)),
                        ],
                      )
                    : Btn('Move to trash', variant: BtnVariant.danger, icon: PhosphorIconsDuotone.trash, onPressed: () => setState(() => _confirmTrash = true)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
