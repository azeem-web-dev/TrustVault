import { describe, expect, it } from 'vitest';
import { evaluate, REQUIRED_LEVEL, type AccessFacts, type DocAction } from '../src/documents/access.js';

// Pure tests of decide(): no database, no HTTP. Every rule in access.ts has
// a case here that fails if the rule is removed.

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-01T12:00:00Z');
const FUTURE = '2026-12-01T00:00:00Z';
const PAST = '2026-10-01T00:00:00Z';

const ALL_ACTIONS = Object.keys(REQUIRED_LEVEL) as DocAction[];
const READ_ACTIONS: DocAction[] = ['view', 'download'];
const EDIT_ACTIONS: DocAction[] = ['edit', 'upload_version'];
const MANAGE_ACTIONS: DocAction[] = ['view_access', 'share', 'view_history'];
const OWNER_ACTIONS: DocAction[] = ['move_folder', 'trash', 'restore', 'purge', 'transfer'];

function facts(over: Partial<AccessFacts> & { role?: AccessFacts['user'] extends infer U ? U extends { role: infer R } ? R : never : never } = {}): AccessFacts {
  return {
    document: { ownerId: OTHER, status: 'ACTIVE' },
    user: { role: over.role ?? 'VIEWER', status: 'ACTIVE', accessExpiresAt: null },
    grants: [],
    breakGlassUntil: null,
    ...over,
  };
}

const allowed = (f: AccessFacts, action: DocAction) => evaluate(f, ME, action, NOW).allowed;
const allowedSet = (f: AccessFacts) => ALL_ACTIONS.filter((a) => allowed(f, a)).sort();

describe('decide(): deny by default', () => {
  it('no grant, not owner: nothing is allowed', () => {
    expect(allowedSet(facts())).toEqual([]);
  });

  it('a document that does not exist: nothing is allowed', () => {
    expect(allowedSet(facts({ document: null }))).toEqual([]);
    expect(evaluate(facts({ document: null }), ME, 'view', NOW).reason).toBe('no_such_document');
  });

  it('an unknown user: nothing is allowed', () => {
    expect(allowedSet(facts({ user: null, document: { ownerId: ME, status: 'ACTIVE' } }))).toEqual([]);
  });
});

describe('decide(): levels map to actions', () => {
  it('READ grant allows exactly view and download', () => {
    expect(allowedSet(facts({ grants: [{ level: 'READ', expiresAt: null, viaGroup: false }] }))).toEqual([...READ_ACTIONS].sort());
  });

  it('EDIT grant adds edit and upload_version, nothing more', () => {
    expect(allowedSet(facts({ grants: [{ level: 'EDIT', expiresAt: null, viaGroup: false }] }))).toEqual([...READ_ACTIONS, ...EDIT_ACTIONS].sort());
  });

  it('MANAGE grant adds access/sharing/history, but never owner actions', () => {
    const set = allowedSet(facts({ grants: [{ level: 'MANAGE', expiresAt: null, viaGroup: false }] }));
    expect(set).toEqual([...READ_ACTIONS, ...EDIT_ACTIONS, ...MANAGE_ACTIONS].sort());
    for (const a of OWNER_ACTIONS) expect(set).not.toContain(a);
  });

  it('the owner can do everything on an active document', () => {
    expect(allowedSet(facts({ document: { ownerId: ME, status: 'ACTIVE' } }))).toEqual([...ALL_ACTIONS].sort());
  });

  it('the highest of several grants wins', () => {
    const f = facts({ grants: [{ level: 'READ', expiresAt: null, viaGroup: false }, { level: 'EDIT', expiresAt: null, viaGroup: true }] });
    expect(allowed(f, 'edit')).toBe(true);
    expect(allowed(f, 'share')).toBe(false);
  });
});

describe('decide(): grants that must not count', () => {
  it('an expired grant gives nothing', () => {
    expect(allowedSet(facts({ grants: [{ level: 'MANAGE', expiresAt: PAST, viaGroup: false }] }))).toEqual([]);
  });

  it('a grant expiring exactly now gives nothing', () => {
    expect(allowed(facts({ grants: [{ level: 'READ', expiresAt: NOW.toISOString(), viaGroup: false }] }), 'view')).toBe(false);
  });

  it('a grant with a future expiry counts', () => {
    expect(allowed(facts({ grants: [{ level: 'READ', expiresAt: FUTURE, viaGroup: false }] }), 'download')).toBe(true);
  });

  it('external users never get access through a group', () => {
    expect(allowedSet(facts({ role: 'EXTERNAL', grants: [{ level: 'READ', expiresAt: FUTURE, viaGroup: true }] }))).toEqual([]);
  });

  it('external users are capped at READ even if a grant says more', () => {
    const f = facts({ role: 'EXTERNAL', grants: [{ level: 'MANAGE', expiresAt: FUTURE, viaGroup: false }] });
    expect(allowedSet(f)).toEqual([...READ_ACTIONS].sort());
  });
});

describe('decide(): account state', () => {
  it('a deactivated user gets nothing, even as owner', () => {
    const f = facts({ document: { ownerId: ME, status: 'ACTIVE' }, user: { role: 'OWNER', status: 'DEACTIVATED', accessExpiresAt: null } });
    expect(allowedSet(f)).toEqual([]);
    expect(evaluate(f, ME, 'view', NOW).reason).toBe('user_inactive');
  });

  it('an account past its access expiry gets nothing', () => {
    const f = facts({ user: { role: 'EXTERNAL', status: 'ACTIVE', accessExpiresAt: PAST }, grants: [{ level: 'READ', expiresAt: FUTURE, viaGroup: false }] });
    expect(allowedSet(f)).toEqual([]);
  });
});

describe('decide(): trash', () => {
  it('nobody but the owner can see a deleted document, whatever their grant', () => {
    const f = facts({ document: { ownerId: OTHER, status: 'DELETED' }, grants: [{ level: 'MANAGE', expiresAt: null, viaGroup: false }] });
    expect(allowedSet(f)).toEqual([]);
  });

  it('the owner of a deleted document can view, download, restore, purge and see history only', () => {
    const f = facts({ document: { ownerId: ME, status: 'DELETED' } });
    expect(allowedSet(f)).toEqual(['download', 'purge', 'restore', 'view', 'view_history']);
  });
});

describe('decide(): admin and break-glass', () => {
  it('the ADMIN role alone gives no document access', () => {
    expect(allowedSet(facts({ role: 'ADMIN' }))).toEqual([]);
  });

  it('a live break-glass window gives an admin READ only', () => {
    expect(allowedSet(facts({ role: 'ADMIN', breakGlassUntil: FUTURE }))).toEqual([...READ_ACTIONS].sort());
  });

  it('an expired break-glass window gives nothing', () => {
    expect(allowedSet(facts({ role: 'ADMIN', breakGlassUntil: PAST }))).toEqual([]);
  });

  it('an admin gets nothing from a direct grant, a group grant, or MANAGE (THREATS.md A17)', () => {
    expect(allowedSet(facts({ role: 'ADMIN', grants: [{ level: 'READ', expiresAt: null, viaGroup: false }] }))).toEqual([]);
    expect(allowedSet(facts({ role: 'ADMIN', grants: [{ level: 'MANAGE', expiresAt: null, viaGroup: true }] }))).toEqual([]);
  });

  it('an admin who somehow owns a document still gets nothing from ownership', () => {
    expect(allowedSet(facts({ role: 'ADMIN', document: { ownerId: ME, status: 'ACTIVE' } }))).toEqual([]);
  });

  it('break-glass gives READ only, even if the admin also holds a grant', () => {
    expect(allowedSet(facts({ role: 'ADMIN', breakGlassUntil: FUTURE, grants: [{ level: 'MANAGE', expiresAt: null, viaGroup: false }] }))).toEqual([...READ_ACTIONS].sort());
  });

  it('break-glass does not open a document in the trash', () => {
    expect(allowedSet(facts({ role: 'ADMIN', breakGlassUntil: FUTURE, document: { ownerId: OTHER, status: 'DELETED' } }))).toEqual([]);
  });

  it('break-glass only works for admins', () => {
    expect(allowedSet(facts({ role: 'OWNER', breakGlassUntil: FUTURE }))).toEqual([]);
  });
});

describe('decide(): ownership is by id, not by role', () => {
  it('an OWNER-role user who does not own this document is treated as anyone else', () => {
    expect(allowedSet(facts({ role: 'OWNER' }))).toEqual([]);
  });
});
