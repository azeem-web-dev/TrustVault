part of '../document_detail.dart';

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
