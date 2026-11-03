import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/ui.dart';
import 'document_detail.dart';
import 'shell.dart';

const _empty = {'q': '', 'owner': '', 'category': '', 'from': '', 'to': '', 'folderId': ''};

class DocumentsScreen extends StatefulWidget {
  const DocumentsScreen({super.key});
  @override
  State<DocumentsScreen> createState() => _DocumentsScreenState();
}

class _DocumentsScreenState extends State<DocumentsScreen> {
  String _scope = 'all';
  Map<String, String> _applied = Map.of(_empty);
  final _search = TextEditingController();
  Timer? _debounce;
  int _page = 1;
  Map? _data;
  Map<String, int?> _counts = {};
  List<String> _categories = [];
  List<Map> _folders = [];
  String? _error;
  bool _grid = false;

  // Null once signed out (a refresh can still finish after that).
  bool get _isOwner => mounted && (context.read<Session>().user?.isOwner ?? false);

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance()
        .then((p) {
          if (mounted && p.getString('tv-docs-view') == 'grid') setState(() => _grid = true);
        })
        .catchError((_) {});
    _refreshAll();
  }

  @override
  void dispose() {
    _search.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    await Future.wait([_load(), _loadMeta()]);
  }

  Future<void> _load() async {
    final params = <String, String>{'scope': _scope, 'page': '$_page'};
    _applied.forEach((k, v) {
      if (v.isNotEmpty) params[k] = k == 'to' ? '${v}T23:59:59' : v;
    });
    try {
      final r = await Api.I.get('/documents?${Uri(queryParameters: params).query}') as Map;
      if (mounted) {
        setState(() {
          _data = r;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _loadMeta() async {
    final scopes = _isOwner ? ['all', 'mine', 'shared', 'trash'] : ['all', 'shared'];
    final results = await Future.wait(
      scopes.map((s) async {
        try {
          final r = await Api.I.get('/documents?scope=$s&page=1') as Map;
          return MapEntry(s, r['total'] as int?);
        } catch (_) {
          return MapEntry<String, int?>(s, null);
        }
      }),
    );
    List<String> cats = _categories;
    try {
      cats = ((await Api.I.get('/documents/categories') as Map)['categories'] as List).cast<String>();
    } catch (_) {}
    if (_isOwner) await _loadFolders();
    if (mounted) {
      setState(() {
        _counts = Map.fromEntries(results);
        _categories = cats;
      });
    }
  }

  Future<void> _loadFolders() async {
    try {
      final f = ((await Api.I.get('/folders') as Map)['folders'] as List).cast<Map>();
      if (mounted) setState(() => _folders = f);
    } catch (_) {}
  }

  void _apply(Map<String, String> f) {
    setState(() {
      _applied = f;
      _page = 1;
      _data = null;
    });
    _load();
  }

  void _onSearch(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _apply({..._applied, 'q': q}));
  }

  void _setView(bool grid) {
    setState(() => _grid = grid);
    SharedPreferences.getInstance().then((p) => p.setString('tv-docs-view', grid ? 'grid' : 'list')).catchError((_) => true);
  }

  void _clearAll() {
    _search.clear();
    _apply(Map.of(_empty));
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final user = context.watch<Session>().user;
    // Signed out: this page is fading out; draw nothing from the old session.
    if (user == null) return const SizedBox.shrink();
    final data = _data;
    final docs = (data?['documents'] as List?)?.cast<Map>() ?? const [];
    final total = (data?['total'] as int?) ?? 0;
    final pageSize = (data?['pageSize'] as int?) ?? 20;
    final pages = data == null ? 1 : ((total / pageSize).ceil()).clamp(1, 1 << 30);
    final advanced = ['owner', 'from', 'to', 'folderId'].where((k) => _applied[k]!.isNotEmpty).length;
    final roleLabel = user.role == 'EXTERNAL'
        ? 'External'
        : user.isAdmin
        ? 'Admin'
        : 'Viewer';

    return PageBody(
      onRefresh: _refreshAll,
      children: [
        PageTitle(
          eyebrow: '${greeting()}, ${user.firstName}',
          title: 'Documents',
          icon: PhosphorIconsDuotone.files,
          subtitle: 'Only documents you own or have been given access to appear here. Search never shows anything else.',
          actions: _isOwner
              ? [
                  Btn('Upload document', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.cloudArrowUp, onPressed: _openUpload),
                  Btn('Folders', icon: PhosphorIconsDuotone.folderSimple, onPressed: _openFolders),
                ]
              : null,
        ),
        StatGrid(
          children: [
            StatCard(label: 'You can open', value: '${_counts['all'] ?? '–'}', icon: PhosphorIconsDuotone.vault, hint: 'Owned by you or shared with you'),
            _isOwner
                ? StatCard(label: 'Owned by you', value: '${_counts['mine'] ?? '–'}', icon: PhosphorIconsDuotone.user, tone: Tone.violet, hint: 'Only you decide who sees these', delay: 60)
                : StatCard(
                    label: 'Your role',
                    value: roleLabel,
                    icon: PhosphorIconsDuotone.user,
                    tone: Tone.violet,
                    hint: user.role == 'EXTERNAL'
                        ? 'Read-only, until access ends'
                        : user.isAdmin
                        ? 'Admins manage people, not documents'
                        : 'You can open what is shared',
                    delay: 60,
                  ),
            StatCard(label: 'Shared with you', value: '${_counts['shared'] ?? '–'}', icon: PhosphorIconsDuotone.usersThree, tone: Tone.green, hint: 'Directly or through a group', delay: 120),
            StatCard(
              label: 'Categories',
              value: '${_categories.length}',
              icon: PhosphorIconsDuotone.tag,
              tone: Tone.amber,
              hint: _categories.isEmpty ? 'None yet' : _categories.take(3).join(', '),
              delay: 180,
            ),
          ],
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: Segmented<String>(
                value: _scope,
                onChanged: (s) {
                  setState(() {
                    _scope = s;
                    _page = 1;
                    _data = null;
                  });
                  _load();
                },
                options: [
                  SegOption('all', 'All', icon: PhosphorIconsDuotone.stack, count: _counts['all']),
                  if (_isOwner) SegOption('mine', 'Mine', icon: PhosphorIconsDuotone.user, count: _counts['mine']),
                  SegOption('shared', 'Shared', icon: PhosphorIconsDuotone.shareNetwork, count: _counts['shared']),
                  if (_isOwner) SegOption('trash', 'Trash', icon: PhosphorIconsDuotone.trash, count: _counts['trash']),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: p.field,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: p.border),
              ),
              child: Row(
                children: [_viewBtn(PhosphorIconsDuotone.rows, 'List view', !_grid, () => _setView(false)), _viewBtn(PhosphorIconsDuotone.squaresFour, 'Grid view', _grid, () => _setView(true))],
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _search,
                onChanged: _onSearch,
                textInputAction: TextInputAction.search,
                decoration: fieldDeco(hint: 'Search name or description', icon: PhosphorIconsDuotone.magnifyingGlass),
              ),
            ),
            const SizedBox(width: 8),
            Stack(
              clipBehavior: Clip.none,
              children: [
                Btn('Filters', icon: PhosphorIconsDuotone.funnelSimple, onPressed: _openFilters),
                if (advanced > 0)
                  Positioned(
                    right: -4,
                    top: -4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: C.brand600, borderRadius: BorderRadius.circular(8)),
                      child: Text(
                        '$advanced',
                        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
        if (_categories.isNotEmpty || advanced > 0) ...[
          const SizedBox(height: 12),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final c in _categories)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: TvChip(c, icon: PhosphorIconsDuotone.tag, selected: _applied['category'] == c, onTap: () => _apply({..._applied, 'category': _applied['category'] == c ? '' : c})),
                  ),
                for (final k in ['owner', 'from', 'to', 'folderId'])
                  if (_applied[k]!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: InputChip(
                        label: Text(_chipLabel(k), style: const TextStyle(fontSize: 12, color: Colors.white)),
                        backgroundColor: p.dark ? C.slate700 : C.slate900,
                        deleteIconColor: Colors.white,
                        side: BorderSide.none,
                        shape: const StadiumBorder(),
                        onDeleted: () => _apply({..._applied, k: ''}),
                      ),
                    ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 16),
        if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), const SizedBox(height: 12)],
        if (data == null)
          TvCard(padded: false, child: const SkeletonRows(rows: 6))
        else if (docs.isEmpty)
          _emptyState(p)
        else if (_grid)
          _DocGrid(docs: docs, trash: _scope == 'trash', onOpen: _open)
        else
          _DocList(docs: docs, trash: _scope == 'trash', onOpen: _open),
        if (data != null && total > pageSize) ...[
          const SizedBox(height: 16),
          Text(
            'Showing ${(_page - 1) * pageSize + 1}–${(_page * pageSize).clamp(0, total)} of $total',
            textAlign: TextAlign.center,
            style: ts(context, size: 12.5, color: p.muted),
          ),
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Btn('Previous', size: BtnSize.sm, icon: PhosphorIconsBold.caretLeft, onPressed: _page <= 1 ? null : () => _goPage(_page - 1)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Text('Page $_page of $pages', style: ts(context, size: 12.5, w: FontWeight.w500)),
              ),
              Btn('Next', size: BtnSize.sm, trailing: PhosphorIconsBold.caretRight, onPressed: _page >= pages ? null : () => _goPage(_page + 1)),
            ],
          ),
        ],
      ],
    );
  }

  String _chipLabel(String k) => switch (k) {
    'owner' => 'Owner: ${_applied['owner']}',
    'from' => 'From ${_applied['from']}',
    'to' => 'To ${_applied['to']}',
    _ => 'Folder: ${_folders.firstWhere((f) => f['id'] == _applied['folderId'], orElse: () => {'name': '…'})['name']}',
  };

  void _goPage(int p) {
    setState(() {
      _page = p;
      _data = null;
    });
    _load();
  }

  Widget _viewBtn(PI icon, String tip, bool on, VoidCallback tap) {
    final p = Pal.of(context);
    return Tooltip(
      message: tip,
      child: GestureDetector(
        onTap: tap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: 36,
          height: 34,
          decoration: BoxDecoration(color: on ? p.soft2 : Colors.transparent, borderRadius: BorderRadius.circular(9)),
          child: Center(child: Ic(icon, size: 18, color: on ? p.text : p.muted)),
        ),
      ),
    );
  }

  Widget _emptyState(Pal p) {
    final filtered = _applied.values.any((v) => v.isNotEmpty);
    Widget body;
    if (_scope == 'trash') {
      body = const EmptyState(
        icon: PhosphorIconsDuotone.trash,
        tone: Tone.slate,
        title: 'The trash is empty',
        body: 'Documents you delete stay here, visible only to you, until the retention period ends.',
      );
    } else if (filtered) {
      body = EmptyState(
        icon: PhosphorIconsDuotone.fileMagnifyingGlass,
        title: 'No documents match',
        body: 'Search only covers documents you can access, so something shared with others but not you will never appear.',
        action: Btn('Clear search and filters', onPressed: _clearAll),
      );
    } else {
      body = EmptyState(
        icon: PhosphorIconsDuotone.files,
        title: _isOwner ? 'Upload your first document' : 'Nothing has been shared with you yet',
        body: _isOwner ? 'It is encrypted, scanned for malware, and visible to nobody until you share it.' : 'When someone shares a document with you, it appears here.',
        action: _isOwner ? Btn('Upload document', variant: BtnVariant.primary, icon: PhosphorIconsBold.plus, onPressed: _openUpload) : null,
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: p.card.withValues(alpha: .6),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: p.dark ? Colors.white.withValues(alpha: .1) : C.slate300),
      ),
      child: body,
    );
  }

  Future<void> _open(String id) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => DocumentDetailScreen(id: id)));
    if (mounted) _refreshAll();
  }

  Future<void> _openFilters() async {
    final f = Map<String, String>.of(_applied);
    final owner = TextEditingController(text: f['owner']);
    final res = await showSheet<Map<String, String>>(
      context,
      title: 'Filters',
      icon: PhosphorIconsDuotone.funnelSimple,
      description: 'Narrow down the documents you can access.',
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) {
          Future<void> pickDate(String key) async {
            final now = DateTime.now();
            final d = await showDatePicker(context: ctx, firstDate: DateTime(2020), lastDate: DateTime(now.year + 1), initialDate: DateTime.tryParse(f[key]!) ?? now);
            if (d != null) set(() => f[key] = isoDay(d));
          }

          Widget dateBtn(String key, String label) => Expanded(
            child: FieldLabel(
              label,
              child: Press(
                onTap: () => pickDate(key),
                child: InputDecorator(
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.calendarBlank),
                  child: Text(f[key]!.isEmpty ? 'Any' : f[key]!, style: ts(ctx, size: 14, color: f[key]!.isEmpty ? C.slate400 : null)),
                ),
              ),
            ),
          );

          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FieldLabel(
                'Owner',
                child: TextField(
                  controller: owner,
                  decoration: fieldDeco(hint: 'name or email', icon: PhosphorIconsDuotone.user),
                ),
              ),
              gap16,
              FieldLabel(
                'Category',
                child: DropdownButtonFormField<String>(
                  initialValue: f['category'],
                  decoration: fieldDeco(icon: PhosphorIconsDuotone.tag),
                  items: [
                    const DropdownMenuItem(value: '', child: Text('Any')),
                    for (final c in _categories) DropdownMenuItem(value: c, child: Text(c)),
                  ],
                  onChanged: (v) => set(() => f['category'] = v ?? ''),
                ),
              ),
              gap16,
              Row(children: [dateBtn('from', 'Uploaded from'), gap12, dateBtn('to', 'to')]),
              if (_isOwner && _folders.isNotEmpty && _scope != 'shared') ...[
                gap16,
                FieldLabel(
                  'Folder',
                  child: DropdownButtonFormField<String>(
                    initialValue: f['folderId'],
                    decoration: fieldDeco(icon: PhosphorIconsDuotone.folderSimple),
                    items: [
                      const DropdownMenuItem(value: '', child: Text('Any')),
                      for (final fo in _folders) DropdownMenuItem(value: fo['id'] as String, child: Text('${fo['name']} (${fo['documents']})')),
                    ],
                    onChanged: (v) => set(() => f['folderId'] = v ?? ''),
                  ),
                ),
              ],
              const SizedBox(height: 22),
              Row(
                children: [
                  Expanded(
                    child: Btn(
                      'Apply filters',
                      variant: BtnVariant.primary,
                      expand: true,
                      icon: PhosphorIconsDuotone.magnifyingGlass,
                      onPressed: () {
                        f['owner'] = owner.text.trim();
                        Navigator.pop(ctx, f);
                      },
                    ),
                  ),
                  gap8,
                  Btn('Clear all', variant: BtnVariant.ghost, onPressed: () => Navigator.pop(ctx, {...Map.of(_empty), 'q': _applied['q']!})),
                ],
              ),
            ],
          );
        },
      ),
    );
    if (res != null) _apply(res);
  }

  Future<void> _openUpload() async {
    final title = await showSheet<String>(
      context,
      title: 'Upload a document',
      icon: PhosphorIconsDuotone.cloudArrowUp,
      description: 'Encrypted with its own key, scanned for malware, and private until you share it.',
      builder: (_) => _UploadForm(folders: _folders, categories: _categories),
    );
    if (title != null && mounted) {
      toast(context, '“$title” uploaded. Nobody else can see it until you share it.');
      setState(() {
        _scope = 'mine';
        _page = 1;
        _data = null;
      });
      _refreshAll();
    }
  }

  Future<void> _openFolders() async {
    await showSheet<void>(
      context,
      title: 'Your folders',
      icon: PhosphorIconsDuotone.folderSimple,
      description: 'Folders only organise your own documents. They are never shared: access is always granted per document.',
      builder: (_) => _FolderManager(initial: _folders, onChanged: (f) => setState(() => _folders = f)),
    );
  }
}

/* ------------------------------------------------------------- list views */

class _DocList extends StatelessWidget {
  const _DocList({required this.docs, required this.trash, required this.onOpen});
  final List<Map> docs;
  final bool trash;
  final ValueChanged<String> onOpen;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return TvCard(
      padded: false,
      child: RowList(
        children: [
          for (var i = 0; i < docs.length; i++)
            Rise(
              delay: i * 25,
              child: InkWell(
                onTap: () => onOpen(docs[i]['id'] as String),
                child: Padding(padding: const EdgeInsets.fromLTRB(14, 13, 14, 13), child: _row(context, p, docs[i])),
              ),
            ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, Pal p, Map d) {
    final cur = d['current'] as Map?;
    final owner = d['owner'] as Map;
    final access = d['myAccess'] as String;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FileIcon(cur?['fileName'] as String?),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      d['title'] as String,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, size: 14.5, w: FontWeight.w600),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TvBadge(accessLabel[access] ?? access, tone: accessTone[access] ?? Tone.neutral, dot: true),
                ],
              ),
              if (cur != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    '${cur['fileName']} · v${cur['versionNo']} · ${formatBytes(cur['sizeBytes'] as num)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(context, size: 12, color: p.muted),
                  ),
                ),
              const SizedBox(height: 8),
              Row(
                children: [
                  TvBadge(d['category'] as String, icon: PhosphorIconsDuotone.tag),
                  const SizedBox(width: 8),
                  Avatar(owner['displayName'] as String, size: 18),
                  const SizedBox(width: 5),
                  Flexible(
                    child: Text(
                      d['isOwner'] == true ? 'You' : owner['displayName'] as String,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ts(context, size: 12, color: p.body),
                    ),
                  ),
                  Text('  ·  ${relativeTime((trash ? d['deletedAt'] : d['updatedAt']) as String?)}', style: ts(context, size: 12, color: p.faint)),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _DocGrid extends StatelessWidget {
  const _DocGrid({required this.docs, required this.trash, required this.onOpen});
  final List<Map> docs;
  final bool trash;
  final ValueChanged<String> onOpen;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final cols = MediaQuery.of(context).size.width > 700 ? 3 : 2;
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: docs.length,
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: cols, mainAxisSpacing: 12, crossAxisSpacing: 12, mainAxisExtent: 196),
      itemBuilder: (_, i) {
        final d = docs[i];
        final cur = d['current'] as Map?;
        final owner = d['owner'] as Map;
        final access = d['myAccess'] as String;
        return Rise(
          delay: i * 30,
          child: Press(
            onTap: () => onOpen(d['id'] as String),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: p.card,
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: p.border),
                boxShadow: p.shadow,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      FileIcon(cur?['fileName'] as String?, size: 44),
                      const Spacer(),
                      TvBadge(accessLabel[access] ?? access, tone: accessTone[access] ?? Tone.neutral, dot: true),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    d['title'] as String,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ts(context, size: 14, w: FontWeight.w600, height: 1.3),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    cur != null ? '${fileType(cur['fileName'] as String).label} · ${formatBytes(cur['sizeBytes'] as num)} · v${cur['versionNo']}' : 'No file',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ts(context, size: 11.5, color: p.muted),
                  ),
                  const Spacer(),
                  Divider(height: 14, color: p.divider),
                  Row(
                    children: [
                      Avatar(owner['displayName'] as String, size: 18),
                      const SizedBox(width: 5),
                      Expanded(
                        child: Text(
                          d['isOwner'] == true ? 'You' : owner['displayName'] as String,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, size: 11.5, color: p.body),
                        ),
                      ),
                      Text(relativeTime((trash ? d['deletedAt'] : d['updatedAt']) as String?), style: ts(context, size: 11, color: p.faint)),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/* ------------------------------------------------------------------ upload */

class _UploadForm extends StatefulWidget {
  const _UploadForm({required this.folders, required this.categories});
  final List<Map> folders;
  final List<String> categories;
  @override
  State<_UploadForm> createState() => _UploadFormState();
}

class _UploadFormState extends State<_UploadForm> {
  final _title = TextEditingController();
  final _desc = TextEditingController();
  String _category = '';
  String _folderId = '';
  PlatformFile? _file;
  int _size = 0;
  bool _busy = false;
  String? _error;

  Future<void> _pick() async {
    final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: const ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'md']);
    if (f == null) return;
    final size = await f.length() ?? 0;
    setState(() {
      _file = f;
      _size = size;
      if (_title.text.isEmpty) _title.text = f.name.replaceAll(RegExp(r'\.[^.]+$'), '').replaceAll(RegExp(r'[-_]+'), ' ');
    });
  }

  Future<void> _submit() async {
    final f = _file;
    if (f == null) return;
    if (_title.text.trim().isEmpty || _category.trim().isEmpty) {
      setState(() => _error = 'Title and category are required.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await Api.I.upload(
        '/documents',
        bytes: await f.readAsBytes(),
        fileName: f.name,
        fields: {'title': _title.text.trim(), 'category': _category.trim(), if (_desc.text.trim().isNotEmpty) 'description': _desc.text.trim(), if (_folderId.isNotEmpty) 'folderId': _folderId},
      );
      if (mounted) Navigator.pop(context, _title.text.trim());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final f = _file;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Press(
          onTap: _pick,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 24),
            decoration: BoxDecoration(
              color: f != null ? (p.dark ? C.emerald500.withValues(alpha: .06) : C.emerald50.withValues(alpha: .6)) : p.soft,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: f != null ? (p.dark ? C.emerald500.withValues(alpha: .4) : C.emerald300) : (p.dark ? Colors.white.withValues(alpha: .15) : C.slate300), width: 1.6),
            ),
            child: f != null
                ? Row(
                    children: [
                      FileIcon(f.name, size: 48),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              f.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: ts(context, size: 14, w: FontWeight.w600),
                            ),
                            Text('${formatBytes(_size)} · ${fileType(f.name).label} · tap to change', style: ts(context, size: 12, color: p.muted)),
                          ],
                        ),
                      ),
                    ],
                  )
                : Column(
                    children: [
                      const IconTile(PhosphorIconsDuotone.cloudArrowUp, size: 48, gradient: true),
                      const SizedBox(height: 12),
                      Text.rich(
                        TextSpan(
                          style: ts(context, size: 14, w: FontWeight.w600),
                          children: [
                            const TextSpan(text: 'Tap to '),
                            TextSpan(
                              text: 'choose a file',
                              style: TextStyle(color: p.accent),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'PDF, images, Word, Excel, PowerPoint, text, CSV or Markdown · up to 25 MB · checked by content, not by name',
                        textAlign: TextAlign.center,
                        style: ts(context, size: 12, color: p.muted, height: 1.45),
                      ),
                    ],
                  ),
          ),
        ),
        gap16,
        FieldLabel(
          'Title',
          child: TextField(
            controller: _title,
            maxLength: 200,
            decoration: fieldDeco(hint: 'e.g. Salary letter 2026').copyWith(counterText: ''),
          ),
        ),
        gap16,
        FieldLabel(
          'Category',
          hint: 'e.g. HR, Legal, Finance',
          child: Autocomplete<String>(
            optionsBuilder: (v) => widget.categories.where((c) => c.toLowerCase().contains(v.text.toLowerCase())),
            onSelected: (v) => _category = v,
            fieldViewBuilder: (ctx, ctrl, focus, submit) => TextField(
              controller: ctrl,
              focusNode: focus,
              maxLength: 60,
              onChanged: (v) => _category = v,
              decoration: fieldDeco(hint: 'Pick or type', icon: PhosphorIconsDuotone.tag).copyWith(counterText: ''),
            ),
          ),
        ),
        gap16,
        FieldLabel(
          'Description (optional)',
          child: TextField(
            controller: _desc,
            maxLines: 2,
            maxLength: 2000,
            decoration: fieldDeco(hint: 'What is it, who is it for?').copyWith(counterText: ''),
          ),
        ),
        if (widget.folders.isNotEmpty) ...[
          gap16,
          FieldLabel(
            'Folder (optional)',
            child: DropdownButtonFormField<String>(
              initialValue: _folderId,
              decoration: fieldDeco(icon: PhosphorIconsDuotone.folderSimple),
              items: [
                const DropdownMenuItem(value: '', child: Text('None')),
                for (final fo in widget.folders) DropdownMenuItem(value: fo['id'] as String, child: Text(fo['name'] as String)),
              ],
              onChanged: (v) => _folderId = v ?? '',
            ),
          ),
        ],
        if (_error != null) ...[gap16, TvAlert(_error!)],
        const SizedBox(height: 22),
        Btn(
          _busy ? 'Encrypting and uploading…' : 'Upload',
          variant: BtnVariant.primary,
          size: BtnSize.lg,
          expand: true,
          icon: PhosphorIconsDuotone.cloudArrowUp,
          loading: _busy,
          onPressed: f == null ? null : _submit,
        ),
      ],
    );
  }
}

/* ----------------------------------------------------------------- folders */

class _FolderManager extends StatefulWidget {
  const _FolderManager({required this.initial, required this.onChanged});
  final List<Map> initial;
  final ValueChanged<List<Map>> onChanged;
  @override
  State<_FolderManager> createState() => _FolderManagerState();
}

class _FolderManagerState extends State<_FolderManager> {
  late List<Map> _folders = widget.initial;
  final _name = TextEditingController();
  String? _error;

  Future<void> _reload() async {
    final f = ((await Api.I.get('/folders') as Map)['folders'] as List).cast<Map>();
    setState(() => _folders = f);
    widget.onChanged(f);
  }

  Future<void> _act(Future<void> Function() fn, String msg) async {
    try {
      await fn();
      setState(() => _error = null);
      if (mounted) toast(context, msg);
      await _reload();
    } catch (e) {
      setState(() => _error = errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _name,
                maxLength: 80,
                onChanged: (_) => setState(() {}),
                decoration: fieldDeco(hint: 'New folder name', icon: PhosphorIconsDuotone.folderSimplePlus).copyWith(counterText: ''),
              ),
            ),
            gap8,
            Btn(
              'Add',
              variant: BtnVariant.primary,
              onPressed: _name.text.trim().isEmpty
                  ? null
                  : () {
                      final n = _name.text.trim();
                      _act(() async {
                        await Api.I.post('/folders', {'name': n});
                        _name.clear();
                      }, 'Folder “$n” created');
                    },
            ),
          ],
        ),
        if (_error != null) ...[gap12, TvAlert(_error!)],
        gap16,
        if (_folders.isEmpty)
          const EmptyState(icon: PhosphorIconsDuotone.folderSimple, tone: Tone.amber, title: 'No folders yet', body: 'Create one to keep your documents tidy.')
        else
          Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: p.border),
            ),
            child: RowList(
              children: [
                for (final f in _folders)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
                    child: Row(
                      children: [
                        const IconTile(PhosphorIconsDuotone.folderSimple, tone: Tone.amber, size: 36),
                        gap12,
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(f['name'] as String, style: ts(context, size: 14, w: FontWeight.w500)),
                              Text('${f['documents']} document${f['documents'] == 1 ? '' : 's'}', style: ts(context, size: 12, color: p.muted)),
                            ],
                          ),
                        ),
                        IconBtn(
                          PhosphorIconsDuotone.trash,
                          tooltip: 'Delete folder ${f['name']}',
                          danger: true,
                          onPressed: () => _act(() => Api.I.delete('/folders/${f['id']}'), 'Folder “${f['name']}” deleted'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}
