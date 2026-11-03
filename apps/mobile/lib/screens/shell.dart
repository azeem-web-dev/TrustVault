import 'dart:async';

import 'package:flutter/material.dart';

import '../widgets/phosphor.dart';

import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/session.dart';
import '../core/theme.dart';
import '../widgets/art.dart';
import '../widgets/ui.dart';
import 'account.dart';
import 'alerts.dart';
import 'approvals.dart';
import 'audit.dart';
import 'document_detail.dart';
import 'documents.dart';
import 'people.dart';

class _Tab {
  const _Tab(this.label, this.icon, this.hint, this.page);
  final String label;
  final PI icon;
  final String hint;
  final Widget page;
}

/// Signed-in frame: brand bar on top, tabs at the bottom, soft brand glow behind.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  List<_Tab> _tabs(User u) => [
    const _Tab('Documents', PhosphorIconsDuotone.files, 'Everything you can open', DocumentsScreen()),
    if (!u.isAdmin) const _Tab('Approvals', PhosphorIconsDuotone.sealCheck, 'Download requests waiting for you', ApprovalsScreen()),
    if (u.isAdmin) ...[
      const _Tab('Audit', PhosphorIconsDuotone.listMagnifyingGlass, 'Who did what, when', AuditScreen()),
      const _Tab('Alerts', PhosphorIconsDuotone.bellRinging, 'Activity worth a look', AlertsScreen()),
      const _Tab('People', PhosphorIconsDuotone.usersThree, 'Users, roles and groups', PeopleScreen()),
    ],
    const _Tab('Account', PhosphorIconsDuotone.userCircleGear, 'Password, passkeys, 2FA', AccountScreen()),
  ];

  @override
  Widget build(BuildContext context) {
    final session = context.watch<Session>();
    final user = session.user;
    // Signed out: this page is fading out; draw nothing from the old session.
    if (user == null) return const SizedBox.shrink();
    final p = Pal.of(context);
    final tabs = _tabs(user);
    if (_index >= tabs.length) _index = 0;

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(child: Backdrop(dark: p.dark)),
          SafeArea(
            bottom: false,
            child: Column(
              children: [
                _TopBar(user: user, onSearch: () => _openSearch(context, tabs), onAccount: () => setState(() => _index = tabs.length - 1)),
                Expanded(
                  child: IndexedStack(index: _index, children: [for (final t in tabs) t.page]),
                ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: p.dark ? C.ink900.withValues(alpha: .96) : Colors.white.withValues(alpha: .97),
          border: Border(top: BorderSide(color: p.border)),
        ),
        child: NavigationBarTheme(
          data: NavigationBarThemeData(
            backgroundColor: Colors.transparent,
            indicatorColor: p.dark ? C.brand500.withValues(alpha: .2) : C.brand50,
            surfaceTintColor: Colors.transparent,
            labelTextStyle: WidgetStateProperty.resolveWith(
              (s) => TextStyle(
                fontFamily: 'Geist',
                fontSize: 11.5,
                fontWeight: s.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w500,
                color: s.contains(WidgetState.selected) ? p.accent : p.muted,
              ),
            ),
          ),
          child: NavigationBar(
            height: 66,
            selectedIndex: _index,
            onDestinationSelected: (i) => setState(() => _index = i),
            destinations: [
              for (final t in tabs)
                NavigationDestination(
                  icon: Ic(t.icon, size: 22, color: p.muted),
                  selectedIcon: Ic(t.icon, size: 22, color: p.accent),
                  label: t.label,
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _openSearch(BuildContext context, List<_Tab> tabs) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(26))),
      builder: (_) => _SearchSheet(pages: [for (var i = 0; i < tabs.length; i++) (i, tabs[i])], onPage: (i) => setState(() => _index = i)),
    );
  }
}

/// Soft brand glow behind every signed-in page (the web's `.app-backdrop`).
class Backdrop extends StatelessWidget {
  const Backdrop({super.key, required this.dark});
  final bool dark;
  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Pal(dark).bg,
      child: Stack(
        children: [
          Positioned(
            right: -160,
            top: -120,
            child: Container(
              width: 460,
              height: 360,
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  colors: [
                    const Color(0xFF6366F1).withValues(alpha: dark ? .17 : .11),
                    Colors.transparent,
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            left: -140,
            bottom: -120,
            child: Container(
              width: 380,
              height: 320,
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  colors: [
                    const Color(0xFFA855F7).withValues(alpha: dark ? .10 : .07),
                    Colors.transparent,
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.user, required this.onSearch, required this.onAccount});
  final User user;
  final VoidCallback onSearch;
  final VoidCallback onAccount;
  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 8, 10, 6),
      child: Row(
        children: [
          const Wordmark(),
          const Spacer(),
          IconBtn(PhosphorIconsDuotone.magnifyingGlass, tooltip: 'Search documents or jump to a page', onPressed: onSearch, color: p.body),
          const SizedBox(width: 2),
          PopupMenuButton<String>(
            tooltip: 'Account menu',
            offset: const Offset(0, 46),
            onSelected: (v) {
              final theme = context.read<ThemeChoice>();
              switch (v) {
                case 'account':
                  onAccount();
                case 'signout':
                  context.read<Session>().signOut();
                case 'light':
                case 'dark':
                case 'system':
                  theme.set(v);
              }
            },
            itemBuilder: (ctx) {
              final mode = context.read<ThemeChoice>().mode;
              PopupMenuItem<String> item(String v, PI icon, String label, {bool danger = false, bool on = false}) => PopupMenuItem(
                value: v,
                height: 42,
                child: Row(
                  children: [
                    Ic(icon, size: 18, color: danger ? C.red500 : (on ? p.accent : p.muted)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        label,
                        style: ts(ctx, size: 14, color: danger ? C.red500 : null, w: on ? FontWeight.w600 : null),
                      ),
                    ),
                    if (on) Ic(PhosphorIconsBold.check, size: 14, color: p.accent),
                  ],
                ),
              );
              return [
                PopupMenuItem(
                  enabled: false,
                  child: Row(
                    children: [
                      Avatar(user.displayName, size: 38),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(user.displayName, style: ts(ctx, size: 14, w: FontWeight.w600)),
                            Text(
                              user.email,
                              overflow: TextOverflow.ellipsis,
                              style: ts(ctx, size: 12, color: p.muted),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const PopupMenuDivider(),
                item('account', PhosphorIconsDuotone.userCircleGear, 'Account & security'),
                const PopupMenuDivider(),
                item('light', PhosphorIconsDuotone.sun, 'Light', on: mode == 'light'),
                item('dark', PhosphorIconsDuotone.moon, 'Dark', on: mode == 'dark'),
                item('system', PhosphorIconsDuotone.deviceMobile, 'Match phone', on: mode == 'system'),
                const PopupMenuDivider(),
                item('signout', PhosphorIconsDuotone.signOut, 'Sign out', danger: true),
              ];
            },
            child: Padding(padding: const EdgeInsets.all(6), child: Avatar(user.displayName, size: 34)),
          ),
        ],
      ),
    );
  }
}

/// The web's Ctrl+K palette as a sheet: jump to a page, or find a document
/// by name. Search only ever returns documents you can access.
class _SearchSheet extends StatefulWidget {
  const _SearchSheet({required this.pages, required this.onPage});
  final List<(int, _Tab)> pages;
  final ValueChanged<int> onPage;
  @override
  State<_SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<_SearchSheet> {
  String _q = '';
  List<Map> _docs = [];
  Timer? _t;

  void _changed(String q) {
    setState(() => _q = q);
    _t?.cancel();
    if (q.trim().length < 2) {
      setState(() => _docs = []);
      return;
    }
    _t = Timer(const Duration(milliseconds: 200), () async {
      try {
        final r = await Api.I.get('/documents?scope=all&page=1&q=${Uri.encodeQueryComponent(q.trim())}') as Map;
        if (mounted) setState(() => _docs = (r['documents'] as List).cast<Map>().take(6).toList());
      } catch (_) {
        if (mounted) setState(() => _docs = []);
      }
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Pal.of(context);
    final pages = widget.pages.where((e) => e.$2.label.toLowerCase().contains(_q.trim().toLowerCase())).toList();
    Widget header(String s) => Padding(
      padding: const EdgeInsets.fromLTRB(4, 14, 4, 6),
      child: Text(
        s.toUpperCase(),
        style: ts(context, size: 11, w: FontWeight.w600, color: p.faint, spacing: 0.8),
      ),
    );
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * .75,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 8),
              child: TextField(
                autofocus: true,
                onChanged: _changed,
                style: ts(context, size: 15),
                decoration: fieldDeco(hint: 'Search documents or jump to a page…', icon: PhosphorIconsDuotone.magnifyingGlass),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                children: [
                  if (_docs.isNotEmpty) header('Documents'),
                  for (final d in _docs)
                    ListTile(
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      leading: FileIcon((d['current'] as Map?)?['fileName'] as String?, size: 34),
                      title: Text(
                        d['title'] as String,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ts(context, size: 14, w: FontWeight.w600),
                      ),
                      subtitle: Text('${d['category']} · ${d['isOwner'] == true ? 'You' : (d['owner'] as Map)['displayName']}', style: ts(context, size: 12, color: p.muted)),
                      trailing: Ic(PhosphorIconsBold.arrowRight, size: 14, color: p.faint),
                      onTap: () {
                        Navigator.pop(context);
                        Navigator.of(context).push(MaterialPageRoute(builder: (_) => DocumentDetailScreen(id: d['id'] as String)));
                      },
                    ),
                  if (pages.isNotEmpty) header('Go to'),
                  for (final (i, t) in pages)
                    ListTile(
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      leading: Container(
                        width: 34,
                        height: 34,
                        decoration: BoxDecoration(color: p.soft2, borderRadius: BorderRadius.circular(10)),
                        child: Center(child: Ic(t.icon, size: 18, color: p.body)),
                      ),
                      title: Text(t.label, style: ts(context, size: 14, w: FontWeight.w600)),
                      subtitle: Text(t.hint, style: ts(context, size: 12, color: p.muted)),
                      trailing: Ic(PhosphorIconsBold.arrowRight, size: 14, color: p.faint),
                      onTap: () {
                        Navigator.pop(context);
                        widget.onPage(i);
                      },
                    ),
                  if (_docs.isEmpty && pages.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(40),
                      child: Text(
                        _q.trim().length < 2 ? 'Type to search.' : 'Nothing you can access matches.',
                        textAlign: TextAlign.center,
                        style: ts(context, size: 13, color: p.muted),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                      'Results only include documents you can access',
                      textAlign: TextAlign.center,
                      style: ts(context, size: 11.5, color: p.faint),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Standard scrolling page body with pull-to-refresh.
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, required this.onRefresh, this.controller});
  final List<Widget> children;
  final Future<void> Function() onRefresh;
  final ScrollController? controller;
  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      color: C.brand500,
      child: ListView(controller: controller, physics: const AlwaysScrollableScrollPhysics(), padding: const EdgeInsets.fromLTRB(16, 10, 16, 40), children: children),
    );
  }
}
