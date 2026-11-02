import 'package:flutter/material.dart';

import 'phosphor.dart';

import '../core/theme.dart';
import 'ui.dart';

class ActionMeta {
  const ActionMeta(this.icon, this.label);
  final PI icon;
  final String label;
}

final _exact = <String, ActionMeta>{
  'document.download': ActionMeta(PhosphorIconsDuotone.downloadSimple, 'Downloaded'),
  'document.view': ActionMeta(PhosphorIconsDuotone.eye, 'Viewed'),
  'document.upload': ActionMeta(PhosphorIconsDuotone.uploadSimple, 'Uploaded'),
  'document.version': ActionMeta(PhosphorIconsDuotone.uploadSimple, 'New version'),
  'document.update': ActionMeta(PhosphorIconsDuotone.pencilSimple, 'Details changed'),
  'document.trash': ActionMeta(PhosphorIconsDuotone.trash, 'Moved to trash'),
  'document.restore': ActionMeta(PhosphorIconsDuotone.arrowCounterClockwise, 'Restored'),
  'document.purge': ActionMeta(PhosphorIconsDuotone.fire, 'Deleted forever'),
  'document.transfer': ActionMeta(PhosphorIconsDuotone.arrowsLeftRight, 'Ownership transferred'),
  'document.move': ActionMeta(PhosphorIconsDuotone.folderSimple, 'Moved to folder'),
  'document.quarantine': ActionMeta(PhosphorIconsDuotone.biohazard, 'Quarantined'),
  'document.integrity': ActionMeta(PhosphorIconsDuotone.shieldWarning, 'Integrity check'),
  'access.grant': ActionMeta(PhosphorIconsDuotone.userPlus, 'Access granted'),
  'access.revoke': ActionMeta(PhosphorIconsDuotone.userMinus, 'Access removed'),
  'access.suggestion': ActionMeta(PhosphorIconsDuotone.userPlus, 'Suggestion'),
  'auth.login': ActionMeta(PhosphorIconsDuotone.signIn, 'Signed in'),
  'auth.logout': ActionMeta(PhosphorIconsDuotone.signOut, 'Signed out'),
  'auth.password_change': ActionMeta(PhosphorIconsDuotone.password, 'Password changed'),
  'malware.rescan': ActionMeta(PhosphorIconsDuotone.bug, 'Malware re-scan'),
  'admin.break_glass': ActionMeta(PhosphorIconsDuotone.siren, 'Break-glass access'),
};

final _prefix = <(String, ActionMeta)>[
  ('mfa.passkey', ActionMeta(PhosphorIconsDuotone.key, 'Passkey')),
  ('mfa.', ActionMeta(PhosphorIconsDuotone.fingerprint, 'Second factor')),
  ('auth.', ActionMeta(PhosphorIconsDuotone.signIn, 'Sign-in')),
  ('access.', ActionMeta(PhosphorIconsDuotone.lockKeyOpen, 'Access')),
  ('group.', ActionMeta(PhosphorIconsDuotone.usersFour, 'Group')),
  ('user.', ActionMeta(PhosphorIconsDuotone.userGear, 'User account')),
  ('admin.', ActionMeta(PhosphorIconsDuotone.userGear, 'Admin action')),
  ('audit.', ActionMeta(PhosphorIconsDuotone.sealCheck, 'Audit')),
  ('break_glass', ActionMeta(PhosphorIconsDuotone.siren, 'Break-glass')),
  ('document.', ActionMeta(PhosphorIconsDuotone.certificate, 'Document')),
];

ActionMeta actionMeta(String action) {
  final e = _exact[action];
  if (e != null) return e;
  if (action.contains('break_glass')) return ActionMeta(PhosphorIconsDuotone.siren, 'Break-glass access');
  final pretty = action.split('.').last.replaceAll('_', ' ');
  for (final (k, m) in _prefix) {
    if (action.startsWith(k)) return ActionMeta(m.icon, '${m.label}: $pretty');
  }
  return ActionMeta(PhosphorIconsDuotone.pulse, pretty);
}

class ActionIcon extends StatelessWidget {
  const ActionIcon(this.action, this.outcome, {super.key, this.size = 34});
  final String action;
  final String outcome;
  final double size;
  @override
  Widget build(BuildContext context) {
    final tone = outcome == 'DENIED'
        ? Tone.red
        : outcome == 'FAILED'
        ? Tone.amber
        : Tone.green;
    final t = toneOf(tone, Pal.of(context).dark);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: t.bg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: t.ring),
      ),
      child: Center(child: Ic(outcome == 'DENIED' ? PhosphorIconsDuotone.prohibit : actionMeta(action).icon, size: 17, color: t.fg)),
    );
  }
}

String outcomeLabel(String o) => o == 'ALLOWED'
    ? 'Allowed'
    : o == 'DENIED'
    ? 'Refused'
    : 'Failed';
