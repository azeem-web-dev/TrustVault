part of '../document_detail.dart';

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
