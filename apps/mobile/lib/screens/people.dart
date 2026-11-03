import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/format.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/approvals.dart';
import '../widgets/ui.dart';
import 'shell.dart';

const _roles = ['ADMIN', 'OWNER', 'VIEWER', 'EXTERNAL'];
final _roleInfo = {
  'ADMIN': ('Administrator', 'Users, audit, alerts. Cannot open documents.', PhosphorIconsDuotone.crown, Tone.violet),
  'OWNER': ('Document owner', 'Uploads documents and shares them.', PhosphorIconsDuotone.briefcase, Tone.blue),
  'VIEWER': ('Viewer', 'Opens what is shared with them.', PhosphorIconsDuotone.eye, Tone.green),
  'EXTERNAL': ('External', 'Read-only, until an end date.', PhosphorIconsDuotone.globe, Tone.amber),
};

/// Users and groups under one tab (two separate pages on the web).
class PeopleScreen extends StatefulWidget {
  const PeopleScreen({super.key});
  @override
  State<PeopleScreen> createState() => _PeopleScreenState();
}

class _PeopleScreenState extends State<PeopleScreen> {
  String _view = 'users';
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
          child: Segmented<String>(
            value: _view,
            expand: true,
            onChanged: (v) => setState(() => _view = v),
            options: const [
              SegOption('users', 'Users', icon: PhosphorIconsDuotone.usersThree),
              SegOption('groups', 'Groups', icon: PhosphorIconsDuotone.usersFour),
            ],
          ),
        ),
        Expanded(
          child: IndexedStack(index: _view == 'users' ? 0 : 1, children: const [_Users(), _Groups()]),
        ),
      ],
    );
  }
}

/* ------------------------------------------------------------------ users */

class _Users extends StatefulWidget {
  const _Users();
  @override
  State<_Users> createState() => _UsersState();
}

class _UsersState extends State<_Users> {
  List<Map>? _users;
  String? _error;
  String _q = '';
  String _filter = 'all';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/admin/users') as Map;
      if (mounted) setState(() => _users = (r['users'] as List).cast<Map>());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not load users'));
    }
  }

  Future<void> _sendReset(String id, String email) async {
    setState(() => _error = null);
    try {
      final r = await Api.I.post('/admin/users/$id/reset-link');
      if (!mounted) return;
      if (r is Map && r['sent'] == false) {
        toast(context, 'Demo accounts never receive email', tone: Tone.blue);
      } else {
        toast(context, 'Reset link sent to $email. You never see their new password.');
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Request failed'));
    }
  }

  // A fresh invitation link; the earlier one stops working.
  Future<void> _resendInvite(String id, String email) async {
    setState(() => _error = null);
    try {
      final r = await Api.I.post('/admin/users/$id/invite');
      if (!mounted) return;
      if (r is Map && r['sent'] == false) {
        toast(context, 'Email is turned off on this server, so no invitation was sent', tone: Tone.blue);
      } else {
        toast(context, 'Invitation sent again to $email. The earlier link no longer works.');
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Request failed'));
    }
  }

  Future<void> _run(Future<dynamic> Function() fn, String msg) async {
    setState(() => _error = null);
    try {
      await fn();
      if (mounted) toast(context, msg);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Request failed'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final me = context.watch<Session>().user;
    final term = _q.trim().toLowerCase();
    final shown = (_users ?? const <Map>[])
        .where((u) => (_filter == 'all' || u['role'] == _filter) && (term.isEmpty || (u['displayName'] as String).toLowerCase().contains(term) || (u['email'] as String).toLowerCase().contains(term)))
        .toList();
    String by(String r) => _users == null ? '–' : '${_users!.where((u) => u['role'] == r).length}';

    return PageBody(
      onRefresh: _load,
      children: [
        PageTitle(
          title: 'Users',
          icon: PhosphorIconsDuotone.usersThree,
          subtitle: 'New people are invited by email and choose their own password. Role changes, deactivation and password resets sign the user out everywhere immediately.',
          actions: [Btn('Invite user', variant: BtnVariant.primary, icon: PhosphorIconsDuotone.userPlus, onPressed: _create)],
        ),
        StatGrid(
          children: [
            for (var i = 0; i < _roles.length; i++)
              StatCard(label: _roleInfo[_roles[i]]!.$1, value: by(_roles[i]), icon: _roleInfo[_roles[i]]!.$3, tone: _roleInfo[_roles[i]]!.$4, hint: _roleInfo[_roles[i]]!.$2, delay: i * 60),
          ],
        ),
        gap16,
        TextField(
          onChanged: (v) => setState(() => _q = v),
          decoration: fieldDeco(hint: 'Search by name or email', icon: PhosphorIconsDuotone.magnifyingGlass),
        ),
        gap12,
        Segmented<String>(
          value: _filter,
          onChanged: (f) => setState(() => _filter = f),
          options: [
            SegOption('all', 'All', count: _users?.length),
            for (final r in _roles) SegOption(r, _roleInfo[r]!.$1.split(' ').first),
          ],
        ),
        gap16,
        if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        TvCard(
          padded: false,
          child: _users == null
              ? const SkeletonRows(rows: 6)
              : shown.isEmpty
              ? const EmptyState(icon: PhosphorIconsDuotone.usersThree, title: 'No users match', body: 'Try another name or role.')
              : RowList(children: [for (final u in shown) _userRow(context, p, u, me)]),
        ),
      ],
    );
  }

  Widget _userRow(BuildContext context, Pal p, Map u, User? me) {
    final locked = u['lockedUntil'] != null && (DateTime.tryParse(u['lockedUntil'] as String)?.isAfter(DateTime.now()) ?? false);
    final self = u['id'] == me?.id;
    final protected = u['isProtected'] == true;
    final active = u['status'] == 'ACTIVE';
    final invited = u['status'] == 'INVITED';
    final email = u['email'] as String;
    return Opacity(
      opacity: active || invited ? 1 : .6,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Avatar(u['displayName'] as String, size: 40),
                gap12,
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text.rich(
                        TextSpan(
                          style: ts(context, size: 14, w: FontWeight.w600),
                          children: [
                            TextSpan(text: u['displayName'] as String),
                            if (self)
                              TextSpan(
                                text: ' (you)',
                                style: TextStyle(fontWeight: FontWeight.w400, color: p.muted),
                              ),
                          ],
                        ),
                      ),
                      Text(
                        email,
                        overflow: TextOverflow.ellipsis,
                        style: ts(context, size: 12, color: p.muted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (invited)
                  const TvBadge('Invited', tone: Tone.amber, icon: PhosphorIconsDuotone.clockCounterClockwise)
                else
                  TvBadge(active ? 'Active' : 'Deactivated', tone: active ? Tone.green : Tone.neutral, dot: true),
                if (locked) const TvBadge('Locked', tone: Tone.amber, icon: PhosphorIconsDuotone.lockKey),
                if (protected) const TvBadge('Demo', tone: Tone.violet, icon: PhosphorIconsDuotone.sparkle),
                if (u['totpEnabledAt'] != null) const TvBadge('2FA', tone: Tone.blue, icon: PhosphorIconsDuotone.shieldCheck),
                if (u['accessExpiresAt'] != null) TvBadge('Until ${formatDay(u['accessExpiresAt'] as String?)}', icon: PhosphorIconsDuotone.calendarBlank),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: u['role'] as String,
                    isExpanded: true,
                    decoration: fieldDeco(icon: _roleInfo[u['role']]?.$3).copyWith(contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9)),
                    items: [
                      for (final r in _roles)
                        DropdownMenuItem(
                          value: r,
                          child: Text(_roleInfo[r]!.$1, style: ts(context, size: 13.5)),
                        ),
                    ],
                    onChanged: (self || protected) ? null : (v) => _run(() => Api.I.patch('/admin/users/${u['id']}', {'role': v}), 'Role changed for $email. They were signed out.'),
                  ),
                ),
                gap8,
                if (self || protected)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Ic(PhosphorIconsDuotone.lock, size: 14, color: p.faint),
                      const SizedBox(width: 4),
                      Text(self ? 'Your account' : 'Protected', style: ts(context, size: 12, color: p.faint)),
                    ],
                  )
                else
                  PopupMenuButton<String>(
                    tooltip: 'Actions for $email',
                    onSelected: (v) {
                      switch (v) {
                        case 'mfa':
                          // An owner's or admin's second factor needs a second
                          // admin's approval (THREATS.md S19): ask for it.
                          if (u['role'] == 'OWNER' || u['role'] == 'ADMIN') {
                            askApproval(
                              context,
                              title: 'Reset the second factor of $email',
                              description: 'Another administrator must approve (Alerts tab); then you clear it from there, once, within 24 hours. They are emailed when it happens.',
                              body: {'action': 'MFA_RESET', 'targetUserId': u['id']},
                            ).then((sent) {
                              if (sent && context.mounted) toast(context, 'Request sent. Another administrator must approve it.');
                            });
                          } else {
                            _run(() => Api.I.post('/admin/users/${u['id']}/mfa/reset'), 'Second factor reset for $email; they must set it up again');
                          }
                        case 'deactivate':
                          _run(() => Api.I.post('/admin/users/${u['id']}/deactivate'), invited ? 'Invitation for $email cancelled' : '$email deactivated and signed out');
                        case 'reactivate':
                          _run(
                            () => Api.I.post('/admin/users/${u['id']}/reactivate'),
                            u['activatedAt'] != null ? '$email reactivated' : '$email is invited again. Use Resend invite to email a new link.',
                          );
                        case 'reset':
                          _sendReset('${u['id']}', email);
                        case 'invite':
                          _resendInvite('${u['id']}', email);
                      }
                    },
                    itemBuilder: (_) => [
                      if (invited)
                        PopupMenuItem(
                          value: 'invite',
                          child: Row(
                            children: [
                              Ic(PhosphorIconsDuotone.envelope, size: 18, color: p.muted),
                              gap8,
                              const Text('Resend invite'),
                            ],
                          ),
                        ),
                      if (active)
                        PopupMenuItem(
                          value: 'reset',
                          child: Row(
                            children: [
                              Ic(PhosphorIconsDuotone.lockKey, size: 18, color: p.muted),
                              gap8,
                              const Text('Send reset link'),
                            ],
                          ),
                        ),
                      if (u['totpEnabledAt'] != null)
                        PopupMenuItem(
                          value: 'mfa',
                          child: Row(
                            children: [
                              Ic(PhosphorIconsDuotone.fingerprint, size: 18, color: p.muted),
                              gap8,
                              const Text('Reset 2FA'),
                            ],
                          ),
                        ),
                      if (active || invited)
                        PopupMenuItem(
                          value: 'deactivate',
                          child: Row(
                            children: [
                              const Ic(PhosphorIconsDuotone.prohibit, size: 18, color: C.red500),
                              const SizedBox(width: 8),
                              Text(invited ? 'Cancel invite' : 'Deactivate', style: const TextStyle(color: C.red500)),
                            ],
                          ),
                        )
                      else
                        PopupMenuItem(
                          value: 'reactivate',
                          child: Row(
                            children: [
                              Ic(PhosphorIconsDuotone.arrowCounterClockwise, size: 18, color: p.muted),
                              gap8,
                              const Text('Reactivate'),
                            ],
                          ),
                        ),
                    ],
                    child: Container(
                      height: 42,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(11),
                        border: Border.all(color: p.fieldBorder),
                        color: p.field,
                      ),
                      child: Row(
                        children: [
                          Text('Actions', style: ts(context, size: 13.5, w: FontWeight.w600)),
                          const SizedBox(width: 4),
                          Ic(PhosphorIconsBold.caretDown, size: 12, color: p.muted),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _create() async {
    final result = await showSheet<(String, bool)>(
      context,
      title: 'Invite a user',
      icon: PhosphorIconsDuotone.userPlus,
      description: 'They get an email with a link to choose their own name and password. You never see it. Administrators also set up a second factor on first sign-in.',
      builder: (_) => const _CreateUser(),
    );
    if (result != null && mounted) {
      final (email, invited) = result;
      if (invited) {
        toast(context, 'Invitation sent to $email. They choose their own name and password.');
      } else {
        toast(context, '$email was added, but email is turned off on this server, so no invitation was sent', tone: Tone.blue);
      }
      _load();
    }
  }
}

class _CreateUser extends StatefulWidget {
  const _CreateUser();
  @override
  State<_CreateUser> createState() => _CreateUserState();
}

class _CreateUserState extends State<_CreateUser> {
  final _email = TextEditingController();
  String _role = 'VIEWER';
  String _expires = '';
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await Api.I.post('/admin/users', {
        'email': _email.text.trim(),
        'role': _role,
        if (_expires.isNotEmpty) 'accessExpiresAt': DateTime.parse(_expires).toUtc().toIso8601String(),
      });
      if (mounted) Navigator.pop(context, (_email.text.trim(), r is Map && r['invited'] == true));
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e, 'Could not send the invitation'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldLabel(
          'Email',
          child: TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            decoration: fieldDeco(hint: 'name@company.com', icon: PhosphorIconsDuotone.envelope),
          ),
        ),
        gap16,
        Text(
          'Role',
          style: ts(context, size: 13, w: FontWeight.w500, color: p.body),
        ),
        gap8,
        for (final r in _roles)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: ChoiceCard(icon: _roleInfo[r]!.$3, title: _roleInfo[r]!.$1, text: _roleInfo[r]!.$2, selected: _role == r, onTap: () => setState(() => _role = r)),
          ),
        gap8,
        FieldLabel(
          _role == 'EXTERNAL' ? 'Access ends on (required)' : 'Access ends on (optional)',
          hint: _role == 'EXTERNAL' ? 'External accounts always have an end date.' : 'Leave empty for no end date.',
          child: Press(
            onTap: () async {
              final now = DateTime.now();
              final d = await showDatePicker(context: context, firstDate: now, lastDate: DateTime(now.year + 5), initialDate: now.add(const Duration(days: 30)));
              if (d != null) setState(() => _expires = isoDay(d));
            },
            child: InputDecorator(
              decoration: fieldDeco(icon: PhosphorIconsDuotone.calendarBlank).copyWith(
                suffixIcon: _expires.isEmpty || _role == 'EXTERNAL'
                    ? null
                    : IconButton(tooltip: 'No end date', icon: Ic(PhosphorIconsBold.x, size: 14, color: p.muted), onPressed: () => setState(() => _expires = '')),
              ),
              child: Text(_expires.isEmpty ? 'Pick a date' : _expires, style: ts(context, size: 14, color: _expires.isEmpty ? C.slate400 : null)),
            ),
          ),
        ),
        if (_error != null) ...[gap16, TvAlert(_error!)],
        gap24,
        Btn('Send invitation', variant: BtnVariant.primary, size: BtnSize.lg, expand: true, icon: PhosphorIconsDuotone.envelope, loading: _busy, onPressed: _submit),
      ],
    );
  }
}

/* ----------------------------------------------------------------- groups */

class _Groups extends StatefulWidget {
  const _Groups();
  @override
  State<_Groups> createState() => _GroupsState();
}

class _GroupsState extends State<_Groups> {
  List<Map>? _groups;
  final _name = TextEditingController();
  String? _error;
  String? _confirmDelete;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await Api.I.get('/admin/groups') as Map;
      if (mounted) setState(() => _groups = (r['groups'] as List).cast<Map>());
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _run(Future<dynamic> Function() fn, String msg) async {
    setState(() => _error = null);
    try {
      await fn();
      if (mounted) toast(context, msg);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final g = _groups;
    return PageBody(
      onRefresh: _load,
      children: [
        const PageTitle(
          title: 'Groups',
          icon: PhosphorIconsDuotone.usersFour,
          subtitle: 'Share a document with a team in one grant. Removing someone from a group removes their access through it on their next request. External people cannot join groups.',
        ),
        TvCard(
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _name,
                  maxLength: 80,
                  onChanged: (_) => setState(() {}),
                  decoration: fieldDeco(hint: 'New group name, e.g. Finance team', icon: PhosphorIconsDuotone.usersFour).copyWith(counterText: ''),
                ),
              ),
              gap8,
              Btn(
                'Create',
                variant: BtnVariant.primary,
                icon: PhosphorIconsBold.plus,
                onPressed: _name.text.trim().isEmpty
                    ? null
                    : () {
                        final n = _name.text.trim();
                        _run(() async {
                          await Api.I.post('/admin/groups', {'name': n});
                          _name.clear();
                        }, 'Group “$n” created');
                      },
              ),
            ],
          ),
        ),
        gap16,
        if (_error != null) ...[TvAlert(_error!, onDismiss: () => setState(() => _error = null)), gap12],
        if (g == null)
          const Column(children: [Skeleton(height: 220, radius: 18), gap16, Skeleton(height: 220, radius: 18)])
        else if (g.isEmpty)
          Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: p.dark ? Colors.white.withValues(alpha: .1) : C.slate300),
            ),
            child: const EmptyState(icon: PhosphorIconsDuotone.usersFour, title: 'No groups yet', body: 'Create one above, then share documents with the whole team at once.'),
          )
        else
          for (var i = 0; i < g.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Rise(delay: i * 50, child: _groupCard(context, p, g[i])),
            ),
      ],
    );
  }

  Widget _groupCard(BuildContext context, Pal p, Map g) {
    final members = (g['members'] as List).cast<Map>();
    final grants = g['documentGrants'] as int;
    final name = g['name'] as String;
    return Container(
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: p.border),
        boxShadow: p.shadow,
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Stack(
            children: [
              Positioned(
                right: -40,
                top: -40,
                child: Container(
                  width: 150,
                  height: 150,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: RadialGradient(colors: [C.brand500.withValues(alpha: .12), Colors.transparent]),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const IconTile(PhosphorIconsDuotone.usersFour, tone: Tone.blue, size: 46),
                        gap12,
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(name, style: ts(context, size: 15.5, w: FontWeight.w600)),
                              const SizedBox(height: 4),
                              Wrap(
                                spacing: 6,
                                runSpacing: 4,
                                children: [
                                  TvBadge('${members.length} member${members.length == 1 ? '' : 's'}'),
                                  TvBadge('$grants document grant${grants == 1 ? '' : 's'}', tone: Tone.blue, icon: PhosphorIconsDuotone.fileText),
                                ],
                              ),
                            ],
                          ),
                        ),
                        if (_confirmDelete == g['id'])
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Btn(
                                'Delete',
                                size: BtnSize.sm,
                                variant: BtnVariant.danger,
                                onPressed: () {
                                  setState(() => _confirmDelete = null);
                                  _run(() => Api.I.delete('/admin/groups/${g['id']}'), 'Deleted $name and its $grants grants');
                                },
                              ),
                              const SizedBox(width: 4),
                              Btn('Keep', size: BtnSize.sm, variant: BtnVariant.ghost, onPressed: () => setState(() => _confirmDelete = null)),
                            ],
                          )
                        else
                          IconBtn(PhosphorIconsDuotone.trash, tooltip: 'Delete group $name', danger: true, onPressed: () => setState(() => _confirmDelete = g['id'] as String)),
                      ],
                    ),
                    if (members.isNotEmpty) ...[
                      gap12,
                      AvatarStack([for (final m in members) m['displayName'] as String], max: 6),
                    ],
                  ],
                ),
              ),
            ],
          ),
          Divider(height: 1, color: p.divider),
          if (members.isEmpty)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                'No members yet.',
                textAlign: TextAlign.center,
                style: ts(context, size: 13, color: p.muted),
              ),
            )
          else
            RowList(
              children: [
                for (final m in members)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                    child: Row(
                      children: [
                        Avatar(m['displayName'] as String, size: 32),
                        gap12,
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(m['displayName'] as String, style: ts(context, size: 13.5, w: FontWeight.w500)),
                              Text(
                                m['email'] as String,
                                overflow: TextOverflow.ellipsis,
                                style: ts(context, size: 12, color: p.muted),
                              ),
                            ],
                          ),
                        ),
                        IconBtn(
                          PhosphorIconsDuotone.userMinus,
                          tooltip: 'Remove ${m['email']} from $name',
                          danger: true,
                          size: 34,
                          onPressed: () => _run(() => Api.I.delete('/admin/groups/${g['id']}/members/${m['id']}'), 'Removed ${m['email']} from $name'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          _AddMember(
            existing: [for (final m in members) m['id'] as String],
            onAdd: (u) => _run(() => Api.I.post('/admin/groups/${g['id']}/members', {'userId': u['id']}), 'Added ${u['displayName']} to $name'),
          ),
        ],
      ),
    );
  }
}

class _AddMember extends StatefulWidget {
  const _AddMember({required this.existing, required this.onAdd});
  final List<String> existing;
  final ValueChanged<Map> onAdd;
  @override
  State<_AddMember> createState() => _AddMemberState();
}

class _AddMemberState extends State<_AddMember> {
  final _q = TextEditingController();
  List<Map> _users = [];
  Timer? _t;

  @override
  void dispose() {
    _t?.cancel();
    _q.dispose();
    super.dispose();
  }

  void _search(String q) {
    _t?.cancel();
    if (q.trim().length < 2) {
      setState(() => _users = []);
      return;
    }
    _t = Timer(const Duration(milliseconds: 250), () async {
      try {
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (mounted) setState(() => _users = (r['users'] as List).cast<Map>().where((u) => u['role'] != 'EXTERNAL' && !widget.existing.contains(u['id'])).toList());
      } catch (_) {}
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.soft,
        border: Border(top: BorderSide(color: p.divider)),
      ),
      child: Column(
        children: [
          TextField(
            controller: _q,
            onChanged: _search,
            decoration: fieldDeco(hint: 'Add a member: type a name or email', icon: PhosphorIconsDuotone.magnifyingGlass),
          ),
          for (final u in _users)
            Container(
              margin: const EdgeInsets.only(top: 6),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: p.card, borderRadius: BorderRadius.circular(12), boxShadow: p.shadow),
              child: Row(
                children: [
                  Avatar(u['displayName'] as String, size: 30),
                  gap8,
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(u['displayName'] as String, style: ts(context, size: 13.5, w: FontWeight.w500)),
                        Text(
                          u['email'] as String,
                          overflow: TextOverflow.ellipsis,
                          style: ts(context, size: 12, color: p.muted),
                        ),
                      ],
                    ),
                  ),
                  Btn(
                    'Add',
                    size: BtnSize.sm,
                    icon: PhosphorIconsDuotone.userPlus,
                    onPressed: () {
                      widget.onAdd(u);
                      _q.clear();
                      setState(() => _users = []);
                    },
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
