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

/// Cross-fades a card body from skeleton to content (§2.3); instant under
/// reduced motion.
Widget _swap(BuildContext context, Object state, Widget child) => AnimatedSwitcher(
  duration: Motion.of(context),
  switchInCurve: Motion.curve,
  switchOutCurve: Motion.easeIn,
  layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
  child: KeyedSubtree(key: ValueKey(state), child: child),
);

/// Users and groups under one tab (two separate pages on the web).
class PeopleScreen extends StatefulWidget {
  const PeopleScreen({super.key});
  @override
  State<PeopleScreen> createState() => _PeopleScreenState();
}

class _PeopleScreenState extends State<PeopleScreen> with SingleTickerProviderStateMixin {
  String _view = 'users';

  /// Fades the view in on a Users / Groups switch without rebuilding it, so
  /// each keeps its list, search and scroll (§2.3).
  late final AnimationController _fade = AnimationController(vsync: this, duration: Motion.base, value: 1);
  late final Animation<double> _fadeIn = CurvedAnimation(parent: _fade, curve: Motion.easeOut);

  @override
  void dispose() {
    _fade.dispose();
    super.dispose();
  }

  void _switch(String v) {
    if (v == _view) return;
    setState(() => _view = v);
    if (Motion.reduced(context)) return;
    _fade.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
          child: Segmented<String>(
            value: _view,
            expand: true,
            onChanged: _switch,
            options: const [
              SegOption('users', 'Users', icon: PhosphorIconsDuotone.usersThree),
              SegOption('groups', 'Groups', icon: PhosphorIconsDuotone.usersFour),
            ],
          ),
        ),
        Expanded(
          child: FadeTransition(
            opacity: _fadeIn,
            child: IndexedStack(index: _view == 'users' ? 0 : 1, children: const [_Users(), _Groups()]),
          ),
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

  /// Error from the last load (R5). Action errors are toasts, because the
  /// row that failed may be far below the top of the list.
  String? _loadError;
  String _q = '';
  final _search = TextEditingController();
  String _filter = 'all';

  /// Id of the user whose action is running; row controls wait for it.
  String? _busy;

  /// Bumped after every role change so the dropdowns remount and show the
  /// role the server has, not a rejected choice (R7).
  int _rev = 0;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    try {
      final r = await Api.I.get('/admin/users') as Map;
      if (mounted && gen == _gen) {
        setState(() {
          _users = (r['users'] as List).cast<Map>();
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _loadError = errorText(e, 'Could not load users'));
    }
  }

  void _fail(Object e) {
    if (mounted) toast(context, errorText(e, 'Request failed'), tone: Tone.red);
  }

  /// Runs [fn] for user [id]; one row action at a time.
  Future<T?> _guard<T>(String id, Future<T> Function() fn) async {
    if (_busy != null) return null;
    setState(() => _busy = id);
    try {
      return await fn();
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _sendReset(String id, String email) async {
    if (_busy != null) return;
    try {
      final r = await _guard(id, () => Api.I.post('/admin/users/$id/reset-link'));
      if (!mounted) return;
      if (r is Map && r['sent'] == false) {
        toast(context, 'Demo accounts never receive email', tone: Tone.blue);
      } else {
        toast(context, 'Reset link sent to $email. You never see their new password.');
      }
    } catch (e) {
      _fail(e);
    }
  }

  // A fresh invitation link; the earlier one stops working.
  Future<void> _resendInvite(String id, String email) async {
    if (_busy != null) return;
    try {
      final r = await _guard(id, () => Api.I.post('/admin/users/$id/invite'));
      if (!mounted) return;
      if (r is Map && r['sent'] == false) {
        toast(context, 'Email is turned off on this server, so no invitation was sent', tone: Tone.blue);
      } else {
        toast(context, 'Invitation sent again to $email. The earlier link no longer works.');
      }
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _run(String id, Future<dynamic> Function() fn, String msg) async {
    try {
      await _guard(id, () async {
        await fn();
        if (mounted) toast(context, msg);
        await _load();
      });
    } catch (e) {
      _fail(e);
    }
  }

  Future<void> _changeRole(Map u, String? role) async {
    final email = u['email'] as String;
    if (role != null && role != u['role']) {
      final info = _roleInfo[role]!;
      final ok = await showConfirm(
        context,
        'Make $email ${info.$1.toLowerCase()}?',
        '${info.$2} They will be signed out everywhere at once.',
        confirmLabel: 'Change role',
        icon: info.$3,
      );
      if (ok && mounted) await _run('${u['id']}', () => Api.I.patch('/admin/users/${u['id']}', {'role': role}), 'Role changed for $email. They were signed out.');
    }
    // Remount the dropdown so it shows the server's role, also after Cancel
    // or a refused change.
    if (mounted) setState(() => _rev++);
  }

  Future<void> _confirmThen(String title, String body, String label, Future<void> Function() action) async {
    final ok = await showConfirm(context, title, body, danger: true, confirmLabel: label);
    if (ok && mounted) await action();
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
          controller: _search,
          onChanged: (v) => setState(() => _q = v),
          textInputAction: TextInputAction.search,
          decoration: fieldDeco(
            hint: 'Search by name or email',
            icon: PhosphorIconsDuotone.magnifyingGlass,
            suffix: _q.isEmpty
                ? null
                : IconBtn(PhosphorIconsBold.x, tooltip: 'Clear search', size: 32, onPressed: () => setState(() {
                    _q = '';
                    _search.clear();
                  })),
          ),
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
        if (_users != null && _loadError != null) ...[
          TvAlert(_loadError!, tone: Tone.amber, title: 'Could not refresh', onDismiss: () => setState(() => _loadError = null)),
          gap12,
        ],
        TvCard(
          padded: false,
          child: _swap(
            context,
            _users == null ? (_loadError != null ? 'error' : 'loading') : (shown.isEmpty ? 'empty' : 'list'),
            _users == null
                ? (_loadError != null ? ErrorState(title: 'Could not load users', message: _loadError, onRetry: _load) : const SkeletonRows(rows: 6))
                : shown.isEmpty
                ? EmptyState(
                    icon: PhosphorIconsDuotone.magnifyingGlass,
                    title: 'No users match',
                    body: 'Try another name or role.',
                    action: term.isEmpty && _filter == 'all' ? null : Btn('Show everyone', icon: PhosphorIconsDuotone.usersThree, onPressed: () => setState(() {
                      _q = '';
                      _filter = 'all';
                      _search.clear();
                    })),
                  )
                : RowList(
                    children: [
                      for (var i = 0; i < shown.length; i++)
                        Rise(key: ValueKey(shown[i]['id']), delay: (i < 8 ? i : 8) * 40, child: _userRow(context, p, shown[i], me)),
                    ],
                  ),
          ),
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
    final id = '${u['id']}';
    // Authenticator app or email codes: both can be reset (R7, web parity).
    final has2fa = u['totpEnabledAt'] != null || u['emailOtpEnabledAt'] != null;
    final rowBusy = _busy == id;
    final idle = _busy == null;
    return AnimatedOpacity(
      duration: Motion.of(context),
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
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
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
                if (has2fa) const TvBadge('2FA', tone: Tone.blue, icon: PhosphorIconsDuotone.shieldCheck),
                if (u['accessExpiresAt'] != null) TvBadge('Until ${formatDay(u['accessExpiresAt'] as String?)}', icon: PhosphorIconsDuotone.calendarBlank),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: ValueKey('$id-${u['role']}-$_rev'),
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
                    onChanged: (self || protected || !idle) ? null : (v) => _changeRole(u, v),
                  ),
                ),
                gap8,
                if (self || protected)
                  Container(
                    height: kMinTap,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(color: p.soft, borderRadius: BorderRadius.circular(11), border: Border.all(color: p.line)),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Ic(PhosphorIconsDuotone.lock, size: 14, color: p.muted),
                        const SizedBox(width: 4),
                        Text(self ? 'Your account' : 'Protected', style: ts(context, size: 12, color: p.muted)),
                      ],
                    ),
                  )
                else
                  PopupMenuButton<String>(
                    tooltip: 'Actions for $email',
                    enabled: idle,
                    position: PopupMenuPosition.under,
                    popUpAnimationStyle: AnimationStyle(duration: Motion.of(context), reverseDuration: Motion.of(context, Motion.fast)),
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
                            _confirmThen(
                              'Reset the second factor of $email?',
                              'Their authenticator app and email codes are cleared, and they are told by email. They must set up a second factor again.',
                              'Reset 2FA',
                              () => _run(id, () => Api.I.post('/admin/users/${u['id']}/mfa/reset'), 'Second factor reset for $email; they must set it up again'),
                            );
                          }
                        case 'deactivate':
                          _confirmThen(
                            invited ? 'Cancel the invitation for $email?' : 'Deactivate $email?',
                            invited ? 'Their invitation link stops working. You can invite them again later.' : 'They are signed out everywhere at once and cannot sign in until reactivated.',
                            invited ? 'Cancel invite' : 'Deactivate',
                            () => _run(id, () => Api.I.post('/admin/users/${u['id']}/deactivate'), invited ? 'Invitation for $email cancelled' : '$email deactivated and signed out'),
                          );
                        case 'reactivate':
                          _run(
                            id,
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
                      if (has2fa)
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
                              Ic(PhosphorIconsDuotone.prohibit, size: 18, color: p.danger),
                              gap8,
                              Text(invited ? 'Cancel invite' : 'Deactivate', style: TextStyle(color: p.danger, fontWeight: FontWeight.w500)),
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
                      height: kMinTap,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(11),
                        border: Border.all(color: p.fieldBorder),
                        color: p.field,
                      ),
                      child: AnimatedOpacity(
                        duration: Motion.of(context, Motion.fast),
                        opacity: idle || rowBusy ? 1 : .5,
                        child: Row(
                          children: [
                            Text('Actions', style: ts(context, size: 13.5, w: FontWeight.w600, color: idle ? null : p.muted)),
                            const SizedBox(width: 6),
                            rowBusy
                                ? SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: p.accent))
                                : Ic(PhosphorIconsBold.caretDown, size: 14, color: p.muted),
                          ],
                        ),
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

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
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
        for (var i = 0; i < _roles.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Rise(
              delay: i * 40,
              dy: 6,
              child: ChoiceCard(icon: _roleInfo[_roles[i]]!.$3, title: _roleInfo[_roles[i]]!.$1, text: _roleInfo[_roles[i]]!.$2, selected: _role == _roles[i], onTap: () => setState(() => _role = _roles[i])),
            ),
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
                    : IconBtn(PhosphorIconsBold.x, tooltip: 'No end date', size: 32, onPressed: () => setState(() => _expires = '')),
              ),
              child: Text(_expires.isEmpty ? 'Pick a date' : _expires, style: ts(context, size: 14, color: _expires.isEmpty ? p.muted : null)),
            ),
          ),
        ),
        if (_error != null) ...[gap16, Rise(dy: 6, child: TvAlert(_error!))],
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

  /// Error from the last load (R5). Action errors are toasts, since the card
  /// that failed may be far down the page.
  String? _loadError;
  String? _confirmDelete;

  /// The running action (`create`, `del-GROUP`, `rm-GROUP-USER`,
  /// `add-GROUP`); other actions wait until it finishes.
  String? _busy;
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final gen = ++_gen;
    try {
      final r = await Api.I.get('/admin/groups') as Map;
      if (mounted && gen == _gen) {
        setState(() {
          _groups = (r['groups'] as List).cast<Map>();
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted && gen == _gen) setState(() => _loadError = errorText(e));
    }
  }

  /// Returns true on success.
  Future<bool> _run(String key, Future<dynamic> Function() fn, String msg) async {
    if (_busy != null) return false;
    setState(() => _busy = key);
    try {
      await fn();
      if (mounted) toast(context, msg);
      await _load();
      return true;
    } catch (e) {
      if (mounted) toast(context, errorText(e), tone: Tone.red);
      return false;
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  void _create() {
    final n = _name.text.trim();
    if (n.isEmpty || _busy != null) return;
    _run('create', () async {
      await Api.I.post('/admin/groups', {'name': n});
      _name.clear();
    }, 'Group “$n” created');
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
                  readOnly: _busy == 'create',
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _create(),
                  onChanged: (_) => setState(() {}),
                  decoration: fieldDeco(hint: 'New group name, e.g. Finance team', icon: PhosphorIconsDuotone.usersFour).copyWith(counterText: ''),
                ),
              ),
              gap8,
              Btn(
                'Create',
                variant: BtnVariant.primary,
                icon: PhosphorIconsBold.plus,
                loading: _busy == 'create',
                onPressed: _name.text.trim().isEmpty || _busy != null ? null : _create,
              ),
            ],
          ),
        ),
        gap16,
        if (g != null && _loadError != null) ...[
          TvAlert(_loadError!, tone: Tone.amber, title: 'Could not refresh', onDismiss: () => setState(() => _loadError = null)),
          gap12,
        ],
        _swap(
          context,
          g == null ? (_loadError != null ? 'error' : 'loading') : (g.isEmpty ? 'empty' : 'list'),
          g == null && _loadError != null
              ? TvCard(padded: false, child: ErrorState(title: 'Could not load groups', message: _loadError, onRetry: _load))
              : g == null
              ? const Column(children: [Skeleton(height: 220, radius: 18), gap16, Skeleton(height: 220, radius: 18)])
              : g.isEmpty
              ? Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: p.dashed),
                  ),
                  child: const EmptyState(icon: PhosphorIconsDuotone.usersFour, title: 'No groups yet', body: 'Create one above, then share documents with the whole team at once.'),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = 0; i < g.length; i++)
                      Padding(
                        key: ValueKey(g[i]['id']),
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Rise(delay: (i < 8 ? i : 8) * 40, child: _groupCard(context, p, g[i])),
                      ),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _groupCard(BuildContext context, Pal p, Map g) {
    final members = (g['members'] as List).cast<Map>();
    final grants = g['documentGrants'] as int;
    final name = g['name'] as String;
    final gid = g['id'] as String;
    final idle = _busy == null;
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
                    gradient: RadialGradient(colors: [C.brand500.withValues(alpha: .12), C.brand500.withValues(alpha: 0)]),
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
                        // Trash ↔ Delete / Keep cross-fades in place.
                        AnimatedSwitcher(
                          duration: Motion.of(context, Motion.fast),
                          transitionBuilder: (c, a) => FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: .94, end: 1.0).animate(a), alignment: Alignment.centerRight, child: c)),
                          child: _confirmDelete == g['id']
                          ? Row(
                            key: const ValueKey('confirm'),
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Btn(
                                'Delete',
                                size: BtnSize.sm,
                                variant: BtnVariant.danger,
                                icon: PhosphorIconsDuotone.trash,
                                loading: _busy == 'del-$gid',
                                onPressed: idle
                                    ? () async {
                                        await _run('del-$gid', () => Api.I.delete('/admin/groups/$gid'), 'Deleted $name and its $grants grants');
                                        if (mounted) setState(() => _confirmDelete = null);
                                      }
                                    : null,
                              ),
                              const SizedBox(width: 4),
                              Btn('Keep', size: BtnSize.sm, variant: BtnVariant.ghost, onPressed: _busy == 'del-$gid' ? null : () => setState(() => _confirmDelete = null)),
                            ],
                          )
                          : IconBtn(PhosphorIconsDuotone.trash, key: const ValueKey('trash'), tooltip: 'Delete group $name', danger: true, onPressed: idle ? () => setState(() => _confirmDelete = gid) : null),
                        ),
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
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Ic(PhosphorIconsDuotone.userPlus, size: 16, color: p.muted),
                  gap8,
                  Text('No members yet. Add someone below.', style: ts(context, size: 13, color: p.muted)),
                ],
              ),
            )
          else
            RowList(
              children: [
                for (final m in members)
                  Padding(
                    key: ValueKey(m['id']),
                    padding: const EdgeInsets.fromLTRB(16, 6, 6, 6),
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
                        if (_busy == 'rm-$gid-${m['id']}')
                          SizedBox(
                            width: kMinTap,
                            height: kMinTap,
                            child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: p.danger))),
                          )
                        else
                          IconBtn(
                            PhosphorIconsDuotone.userMinus,
                            tooltip: 'Remove ${m['email']} from $name',
                            danger: true,
                            onPressed: idle ? () => _removeMember(gid, name, m) : null,
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          _AddMember(
            existing: [for (final m in members) m['id'] as String],
            busy: _busy != null,
            adding: _busy == 'add-$gid',
            onAdd: (u) => _run('add-$gid', () => Api.I.post('/admin/groups/$gid/members', {'userId': u['id']}), 'Added ${u['displayName']} to $name'),
          ),
        ],
      ),
    );
  }

  Future<void> _removeMember(String gid, String name, Map m) async {
    final ok = await showConfirm(
      context,
      'Remove ${m['displayName']} from $name?',
      'They lose access to documents shared with $name on their next request, unless the documents are shared with them another way.',
      danger: true,
      confirmLabel: 'Remove',
      icon: PhosphorIconsDuotone.userMinus,
    );
    if (ok && mounted) await _run('rm-$gid-${m['id']}', () => Api.I.delete('/admin/groups/$gid/members/${m['id']}'), 'Removed ${m['email']} from $name');
  }
}

class _AddMember extends StatefulWidget {
  const _AddMember({required this.existing, required this.onAdd, this.busy = false, this.adding = false});
  final List<String> existing;

  /// Resolves true when the member was added.
  final Future<bool> Function(Map) onAdd;

  /// Another group action is running: Add waits.
  final bool busy;

  /// This group's Add is running.
  final bool adding;
  @override
  State<_AddMember> createState() => _AddMemberState();
}

class _AddMemberState extends State<_AddMember> {
  final _q = TextEditingController();
  List<Map> _users = [];
  Timer? _t;

  /// Request counter: a slow answer for an older query never overwrites a
  /// newer one (R7).
  int _seq = 0;
  bool _searching = false;
  String? _searchError;
  String? _addingId;

  @override
  void dispose() {
    _t?.cancel();
    _q.dispose();
    super.dispose();
  }

  void _search(String q) {
    _t?.cancel();
    final term = q.trim();
    final seq = ++_seq;
    if (term.length < 2) {
      setState(() {
        _users = [];
        _searching = false;
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
        final r = await Api.I.get('/directory?q=${Uri.encodeQueryComponent(term)}') as Map;
        if (!mounted || seq != _seq) return;
        setState(() {
          _users = (r['users'] as List).cast<Map>().where((u) => u['role'] != 'EXTERNAL' && !widget.existing.contains(u['id'])).toList();
          _searching = false;
        });
      } catch (e) {
        if (!mounted || seq != _seq) return;
        setState(() {
          _users = [];
          _searching = false;
          _searchError = errorText(e, 'Search failed. Try again.');
        });
      }
    });
  }

  Future<void> _add(Map u) async {
    if (widget.busy || _addingId != null) return;
    setState(() => _addingId = u['id'] as String?);
    final ok = await widget.onAdd(u);
    if (!mounted) return;
    setState(() {
      _addingId = null;
      if (ok) {
        _seq++;
        _t?.cancel();
        _q.clear();
        _users = [];
        _searching = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final term = _q.text.trim();
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.soft,
        border: Border(top: BorderSide(color: p.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _q,
            onChanged: _search,
            decoration: fieldDeco(
              hint: 'Add a member: type a name or email',
              icon: PhosphorIconsDuotone.magnifyingGlass,
              suffix: _searching
                  ? Padding(
                      padding: const EdgeInsets.all(14),
                      child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: p.accent)),
                    )
                  : null,
            ),
          ),
          if (_searchError != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(
                liveRegion: true,
                child: Row(
                  children: [
                    Ic(PhosphorIconsDuotone.warning, size: 14, color: p.danger),
                    const SizedBox(width: 6),
                    Expanded(child: Text(_searchError!, style: ts(context, size: 12.5, color: p.danger))),
                  ],
                ),
              ),
            )
          else if (!_searching && term.length >= 2 && _users.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                children: [
                  Ic(PhosphorIconsDuotone.magnifyingGlass, size: 14, color: p.muted),
                  const SizedBox(width: 6),
                  Expanded(child: Text('No one to add matches “$term”.', style: ts(context, size: 12.5, color: p.muted))),
                ],
              ),
            ),
          for (var i = 0; i < _users.length; i++)
            Rise(
              key: ValueKey(_users[i]['id']),
              delay: (i < 8 ? i : 8) * 40,
              dy: 6,
              child: Builder(builder: (context) {
                final u = _users[i];
                return Container(
              margin: const EdgeInsets.only(top: 6),
              padding: const EdgeInsets.fromLTRB(8, 4, 4, 4),
              decoration: BoxDecoration(color: p.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line), boxShadow: p.shadow),
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
                    loading: widget.adding && _addingId == u['id'],
                    onPressed: widget.busy || _addingId != null ? null : () => _add(u),
                  ),
                ],
              ),
            );
              }),
            ),
        ],
      ),
    );
  }
}
