part of '../document_detail.dart';

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
