'use client';

import type { ReactNode } from 'react';
import {
  ArrowCounterClockwise, ArrowsLeftRight, Biohazard, Bug, Certificate, DownloadSimple, Eye, Fingerprint, Fire, FolderSimple, Key, LockKeyOpen,
  Password, PencilSimple, Prohibit, Pulse, SealCheck, ShieldWarning, SignIn, SignOut, Siren, Trash, UploadSimple, UserGear, UserMinus, UserPlus, UsersFour,
} from '@phosphor-icons/react';

interface Meta { icon: ReactNode; label: string }

const EXACT: Record<string, Meta> = {
  'document.download': { icon: <DownloadSimple size={16} />, label: 'Downloaded' },
  'document.view': { icon: <Eye size={16} />, label: 'Viewed' },
  'document.upload': { icon: <UploadSimple size={16} />, label: 'Uploaded' },
  'document.version': { icon: <UploadSimple size={16} />, label: 'New version' },
  'document.update': { icon: <PencilSimple size={16} />, label: 'Details changed' },
  'document.trash': { icon: <Trash size={16} />, label: 'Moved to trash' },
  'document.restore': { icon: <ArrowCounterClockwise size={16} />, label: 'Restored' },
  'document.purge': { icon: <Fire size={16} />, label: 'Deleted forever' },
  'document.transfer': { icon: <ArrowsLeftRight size={16} />, label: 'Ownership transferred' },
  'document.move': { icon: <FolderSimple size={16} />, label: 'Moved to folder' },
  'document.quarantine': { icon: <Biohazard size={16} />, label: 'Quarantined' },
  'document.integrity': { icon: <ShieldWarning size={16} />, label: 'Integrity check' },
  'access.grant': { icon: <UserPlus size={16} />, label: 'Access granted' },
  'access.revoke': { icon: <UserMinus size={16} />, label: 'Access removed' },
  'access.suggestion': { icon: <UserPlus size={16} />, label: 'Suggestion' },
  'auth.login': { icon: <SignIn size={16} />, label: 'Signed in' },
  'auth.logout': { icon: <SignOut size={16} />, label: 'Signed out' },
  'auth.password_change': { icon: <Password size={16} />, label: 'Password changed' },
  'malware.rescan': { icon: <Bug size={16} />, label: 'Malware re-scan' },
  'admin.break_glass': { icon: <Siren size={16} />, label: 'Break-glass access' },
};

const PREFIX: [string, Meta][] = [
  ['mfa.passkey', { icon: <Key size={16} />, label: 'Passkey' }],
  ['mfa.', { icon: <Fingerprint size={16} />, label: 'Second factor' }],
  ['auth.', { icon: <SignIn size={16} />, label: 'Sign-in' }],
  ['access.', { icon: <LockKeyOpen size={16} />, label: 'Access' }],
  ['group.', { icon: <UsersFour size={16} />, label: 'Group' }],
  ['user.', { icon: <UserGear size={16} />, label: 'User account' }],
  ['admin.', { icon: <UserGear size={16} />, label: 'Admin action' }],
  ['audit.', { icon: <SealCheck size={16} />, label: 'Audit' }],
  ['break_glass', { icon: <Siren size={16} />, label: 'Break-glass' }],
  ['document.', { icon: <Certificate size={16} />, label: 'Document' }],
];

export function actionMeta(action: string): Meta {
  if (EXACT[action]) return EXACT[action];
  if (action.includes('break_glass')) return { icon: <Siren size={16} />, label: 'Break-glass access' };
  const p = PREFIX.find(([k]) => action.startsWith(k));
  const pretty = action.split('.').pop()!.replace(/_/g, ' ');
  return p ? { icon: p[1].icon, label: `${p[1].label}: ${pretty}` } : { icon: <Pulse size={16} />, label: pretty };
}

export const OUTCOME_STYLE = {
  ALLOWED: { dot: 'bg-emerald-500', tile: 'bg-emerald-50 text-emerald-600 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/25' },
  DENIED: { dot: 'bg-red-500', tile: 'bg-red-50 text-red-600 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/25' },
  FAILED: { dot: 'bg-amber-500', tile: 'bg-amber-50 text-amber-600 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25' },
} as const;

export function ActionIcon({ action, outcome }: { action: string; outcome: keyof typeof OUTCOME_STYLE }) {
  const m = actionMeta(action);
  return (
    <span className={`relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${OUTCOME_STYLE[outcome].tile}`}>
      {outcome === 'DENIED' ? <Prohibit size={16} /> : m.icon}
    </span>
  );
}
