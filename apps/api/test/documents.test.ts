import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EICAR } from './fake-clamd.js';
import { appDb, as, auditRows, createUser, login, ORIGIN, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser, approved } from './helpers.js';

// End-to-end: real HTTP, real Postgres with row-level security, real
// encryption. The heart of the brief: one user cannot reach another
// user's documents through any route.

let t: TestApp;
let alice: TestUser, bob: TestUser, victor: TestUser, erin: TestUser, admin: TestUser;
let A: Session, B: Session, V: Session, E: Session, ADM: Session;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@t.io', role: 'OWNER' });
  bob = await createUser({ email: 'bob@t.io', role: 'OWNER' });
  victor = await createUser({ email: 'victor@t.io', role: 'VIEWER' });
  erin = await createUser({ email: 'erin@partner.io', role: 'EXTERNAL' });
  admin = await createUser({ email: 'admin@t.io', role: 'ADMIN' });
  [A, B, V, E, ADM] = await Promise.all([login(t, alice), login(t, bob), login(t, victor), login(t, erin), login(t, admin)]);
});

async function upload(s: Session, title = 'Salary letter', body: Buffer = PDF, name = 'letter.pdf', category = 'HR') {
  const res = await as(t, s).upload('/api/documents', body, name, { title, category });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const grant = (s: Session, docId: string, body: object) => as(t, s).put(`/api/documents/${docId}/access`, body);

/** Every route that names a document, with how to call it. `grantId` should be a real grant on the document. */
function routes(docId: string, grantId = '3f0e7a52-5b1a-4c1e-9d2a-1b2c3d4e5f60') {
  return [
    ['view', (s: Session) => as(t, s).get(`/api/documents/${docId}`)],
    ['download', (s: Session) => as(t, s).get(`/api/documents/${docId}/download`)],
    ['download v1', (s: Session) => as(t, s).get(`/api/documents/${docId}/versions/1/download`)],
    ['pages', (s: Session) => as(t, s).get(`/api/documents/${docId}/pages`)],
    ['page 1', (s: Session) => as(t, s).get(`/api/documents/${docId}/pages/1`)],
    ['offline key', (s: Session) => as(t, s).post(`/api/documents/${docId}/offline-key`)],
    ['edit', (s: Session) => as(t, s).patch(`/api/documents/${docId}`, { title: 'pwned' })],
    ['new version', (s: Session) => as(t, s).upload(`/api/documents/${docId}/versions`, PDF, 'x.pdf')],
    ['access list', (s: Session) => as(t, s).get(`/api/documents/${docId}/access`)],
    ['grant', (s: Session) => grant(s, docId, { userId: s.userId === V.userId ? B.userId : V.userId, level: 'READ' })],
    ['revoke', (s: Session) => as(t, s).delete(`/api/documents/${docId}/access/${grantId}`)],
    ['history', (s: Session) => as(t, s).get(`/api/documents/${docId}/history`)],
    ['suggestions', (s: Session) => as(t, s).get(`/api/documents/${docId}/suggestions`)],
    ['trash', (s: Session) => as(t, s).post(`/api/documents/${docId}/trash`)],
    ['restore', (s: Session) => as(t, s).post(`/api/documents/${docId}/restore`)],
    ['purge', (s: Session) => as(t, s).delete(`/api/documents/${docId}`)],
    ['transfer', (s: Session) => as(t, s).post(`/api/documents/${docId}/transfer`, { newOwnerId: B.userId })],
  ] as const;
}

describe('one user cannot reach another user’s documents', () => {
  it('every document route returns 404 to a user with no grant, and each refusal is audited', async () => {
    const doc = await upload(A);
    // A real grant to someone outside the test, so "revoke" names a grant that exists.
    const carol = await createUser({ email: 'carol@t.io', role: 'VIEWER' });
    const g = await grant(A, doc, { userId: carol.id, level: 'READ' }).expect(200);
    for (const s of [B, V, E, ADM]) {
      for (const [name, call] of routes(doc, g.body.id)) {
        const res = await call(s);
        expect(res.status, `${name} as ${s.userId}`).toBe(404);
      }
    }
    const denials = await auditRows(`document_id = $1 AND outcome = 'DENIED'`, [doc]);
    // 4 users x 17 routes; "purge" by a non-owner etc. all go through decide().
    expect(denials.length).toBeGreaterThanOrEqual(4 * 17);
    // Admins are refused for being admins (THREATS.md A17), everyone else for having no grant.
    expect(denials.every((d) => d.reason === (d.actor_id === ADM.userId ? 'admin_no_document_access' : 'no_grant'))).toBe(true);
    // Nobody's refused revoke removed the grant.
    const access = await as(t, A).get(`/api/documents/${doc}/access`).expect(200);
    expect(access.body.grants.map((x: { id: string }) => x.id)).toEqual([g.body.id]);
  }, 120_000); // 56 refused requests, each audited; slow over a remote test database

  it('a document id that does not exist looks exactly like one you cannot see', async () => {
    const doc = await upload(A);
    const hidden = await as(t, B).get(`/api/documents/${doc}`);
    const missing = await as(t, B).get('/api/documents/3f0e7a52-5b1a-4c1e-9d2a-1b2c3d4e5f60');
    const garbage = await as(t, B).get('/api/documents/not-a-uuid');
    expect([hidden.status, missing.status, garbage.status]).toEqual([404, 404, 404]);
    expect(hidden.body.message).toBe(missing.body.message);
  });

  it('search never returns, counts or hints at documents you cannot read', async () => {
    await upload(A, 'Alice secret merger plan');
    await upload(A, 'Alice board minutes', PDF, 'm.pdf', 'Board');
    for (const s of [B, V, E]) {
      for (const query of ['?q=secret', '?q=Alice', '?owner=alice', '?category=Board', '?scope=all', '?scope=shared', '?scope=trash']) {
        const res = await as(t, s).get(`/api/documents${query}`);
        expect(res.status).toBe(200);
        expect(res.body.total, `${query}`).toBe(0);
        expect(res.body.documents).toEqual([]);
      }
      const cats = await as(t, s).get('/api/documents/categories');
      expect(cats.body.categories).toEqual([]);
    }
  });

  it('only the owner role can upload; viewers and externals cannot', async () => {
    for (const s of [V, E]) {
      const res = await as(t, s).upload('/api/documents', PDF, 'x.pdf', { title: 't', category: 'c' });
      expect(res.status).toBe(403);
    }
    const adminUpload = await as(t, ADM).upload('/api/documents', PDF, 'x.pdf', { title: 't', category: 'c' });
    expect(adminUpload.status).toBe(403);
  });

  it('you cannot set yourself as owner of a new document through the body', async () => {
    const res = await as(t, A).upload('/api/documents', PDF, 'x.pdf', { title: 't', category: 'c', ownerId: B.userId });
    expect(res.status).toBe(400);
  });
});

describe('search finds the right documents by name, owner, category and date', () => {
  // The API coerces from/to with Date: the web sends YYYY-MM-DD for `from` and
  // YYYY-MM-DDT23:59:59 for `to`. Dates here are UTC days, and `to` carries a Z
  // so the test does not depend on the server's time zone.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const titles = async (query: string) => {
    const res = await as(t, V).get(`/api/documents?${query}`);
    expect(res.status, `${query}: ${JSON.stringify(res.body)}`).toBe(200);
    return (res.body.documents as { title: string }[]).map((d) => d.title).sort();
  };

  beforeEach(async () => {
    const minutes = await upload(A, 'Board minutes Q3', PDF, 'minutes.pdf', 'Board');
    const salary = await upload(A, 'Salary letter', PDF, 'letter.pdf', 'HR');
    const plan = await upload(B, 'Bob plan', PDF, 'plan.pdf', 'Board');
    await grant(A, minutes, { userId: V.userId, level: 'READ' }).expect(200);
    await grant(A, salary, { userId: V.userId, level: 'READ' }).expect(200);
    await grant(B, plan, { userId: V.userId, level: 'READ' }).expect(200);
  });

  it('q matches the title, ignoring case', async () => {
    expect(await titles('q=board')).toEqual(['Board minutes Q3']);
    expect(await titles('q=SALARY')).toEqual(['Salary letter']);
  });

  it('owner matches the owner by name or email', async () => {
    expect(await titles('owner=alice')).toEqual(['Board minutes Q3', 'Salary letter']);
    expect(await titles(`owner=${encodeURIComponent('bob@t.io')}`)).toEqual(['Bob plan']);
  });

  it('category matches exactly, ignoring case', async () => {
    expect(await titles('category=Board')).toEqual(['Board minutes Q3', 'Bob plan']);
    expect(await titles('category=hr')).toEqual(['Salary letter']);
    expect(await titles('category=Boa')).toEqual([]);
  });

  it('from/to bound the upload date', async () => {
    const all = ['Board minutes Q3', 'Bob plan', 'Salary letter'];
    expect(await titles(`from=${day(0)}`)).toEqual(all);
    expect(await titles(`from=${day(0)}&to=${day(0)}T23:59:59Z`)).toEqual(all);
    expect(await titles(`to=${day(-1)}T23:59:59Z`)).toEqual([]);
    expect(await titles(`from=${day(1)}`)).toEqual([]);
  });

  it('filters combine', async () => {
    expect(await titles('q=plan&category=Board')).toEqual(['Bob plan']);
    expect(await titles('q=minutes&category=HR')).toEqual([]);
    expect(await titles(`q=board&category=Board&owner=alice&from=${day(0)}`)).toEqual(['Board minutes Q3']);
  });
});

describe('grants give exactly what they say', () => {
  it('READ: can view and download; cannot edit, version, share, see access, history, trash', async () => {
    const doc = await upload(A);
    const own = await grant(A, doc, { userId: V.userId, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
    const dl = await as(t, V).get(`/api/documents/${doc}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    // The stored copy (a PDF is stored rebuilt, THREATS.md C9), sent unchanged: a page-less PDF has nothing to stamp.
    expect(createHash('sha256').update(dl.body as Buffer).digest('hex')).toBe(dl.headers['x-document-sha256']);
    for (const [name, call] of routes(doc, own.body.id).filter(([n]) => !['view', 'download', 'download v1', 'pages', 'page 1', 'offline key'].includes(n))) {
      expect((await call(V)).status, name).toBe(404);
    }
  });

  it('EDIT: can rename and upload a version; cannot share or trash', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'EDIT' }).expect(200);
    await as(t, V).patch(`/api/documents/${doc}`, { title: 'Renamed by Victor' }).expect(200);
    const v2 = await as(t, V).upload(`/api/documents/${doc}/versions`, Buffer.from('version two\n'), 'v2.txt');
    expect(v2.status).toBe(201);
    expect(v2.body.versionNo).toBe(2);
    await grant(V, doc, { userId: B.userId, level: 'READ' }).expect(404);
    await as(t, V).post(`/api/documents/${doc}/trash`).expect(404);
    // EDIT cannot move the owner's document between the owner's folders.
    await as(t, V).patch(`/api/documents/${doc}`, { folderId: null }).expect(404);
  });

  it('MANAGE: can share READ/EDIT, cannot give MANAGE, cannot remove a MANAGE grant, cannot trash or transfer', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'MANAGE' }).expect(200);
    await grant(V, doc, { userId: B.userId, level: 'EDIT' }).expect(200);
    await grant(V, doc, { userId: B.userId, level: 'MANAGE' }).expect(403);
    const access = await as(t, V).get(`/api/documents/${doc}/access`).expect(200);
    expect(access.body.grants).toHaveLength(2);
    await as(t, V).post(`/api/documents/${doc}/trash`).expect(404);
    await as(t, V).post(`/api/documents/${doc}/transfer`, { newOwnerId: B.userId }).expect(404);
  });

  it('nobody can grant themselves more access', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'MANAGE' }).expect(200);
    const self = await grant(V, doc, { userId: V.userId, level: 'MANAGE' });
    expect(self.status).toBe(400);
  });

  it('a manager cannot sneak a MANAGE grant in by changing an existing grant', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'MANAGE' }).expect(200);
    await grant(A, doc, { userId: B.userId, level: 'MANAGE' }).expect(200);
    // V tries to downgrade B's MANAGE (owner-only change).
    await grant(V, doc, { userId: B.userId, level: 'READ' }).expect(403);
  });

  it('external people get READ only, always with an expiry, never beyond their account', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: E.userId, level: 'EDIT', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(400);
    await grant(A, doc, { userId: E.userId, level: 'READ' }).expect(400);
    await grant(A, doc, { userId: E.userId, level: 'READ', expiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString() }).expect(200);
    const access = await as(t, A).get(`/api/documents/${doc}/access`);
    const g = access.body.grants[0];
    // Capped at the account expiry (30 days in the helper).
    expect(new Date(g.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 31 * 86_400_000);
    await as(t, E).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, E).patch(`/api/documents/${doc}`, { title: 'x' }).expect(404);
  });

  it('a grant that has expired stops working', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'READ', expiresAt: new Date(Date.now() + 60_000).toISOString() }).expect(200);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
    await withDb(ownerDb(), (db) => db.query(`ALTER TABLE grants DISABLE TRIGGER grants_guard; UPDATE grants SET expires_at = now() - interval '1 second' WHERE document_id = $1; ALTER TABLE grants ENABLE TRIGGER grants_guard;`.replace('$1', `'${doc}'`)));
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
  });
});

describe('taking access away works immediately', () => {
  it('revoking a grant: the very next request is refused, and the attempt is audited', async () => {
    const doc = await upload(A);
    const g = await grant(A, doc, { userId: V.userId, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, A).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    const res = await as(t, V).get(`/api/documents/${doc}/download`);
    expect(res.status).toBe(404);
    const last = (await auditRows(`document_id = $1 AND actor_id = $2`, [doc, V.userId])).at(-1)!;
    expect(last).toMatchObject({ action: 'document.download', outcome: 'DENIED', reason: 'no_grant' });
  });

  it('removing someone from a group removes their access through it at once', async () => {
    const doc = await upload(A);
    const grp = await as(t, ADM).post('/api/admin/groups', { name: 'Finance' }).expect(201);
    await as(t, ADM).post(`/api/admin/groups/${grp.body.id}/members`, { userId: V.userId }).expect(204);
    await grant(A, doc, { groupId: grp.body.id, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
    const shared = await as(t, V).get('/api/documents?scope=shared');
    expect(shared.body.total).toBe(1);
    await as(t, ADM).delete(`/api/admin/groups/${grp.body.id}/members/${V.userId}`).expect(204);
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
    expect((await as(t, V).get('/api/documents?scope=shared')).body.total).toBe(0);
  });

  it('deactivating a user ends their document access in the same moment', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'READ' }).expect(200);
    await as(t, ADM).post(`/api/admin/users/${V.userId}/deactivate`).expect(200);
    await as(t, V).get(`/api/documents/${doc}`).expect(401);
  });

  it('external groups are impossible: externals cannot be added to a group', async () => {
    const grp = await as(t, ADM).post('/api/admin/groups', { name: 'Partners' }).expect(201);
    await as(t, ADM).post(`/api/admin/groups/${grp.body.id}/members`, { userId: E.userId }).expect(400);
  });
});

describe('trash, purge and transfer', () => {
  it('trashed documents disappear for everyone with a grant, and come back on restore', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'MANAGE' }).expect(200);
    await as(t, A).post(`/api/documents/${doc}/trash`).expect(204);
    await as(t, V).get(`/api/documents/${doc}`).expect(404);
    expect((await as(t, A).get('/api/documents?scope=trash')).body.total).toBe(1);
    await as(t, A).patch(`/api/documents/${doc}`, { title: 'x' }).expect(404); // no edits in the trash
    await as(t, A).post(`/api/documents/${doc}/restore`).expect(204);
    await as(t, V).get(`/api/documents/${doc}`).expect(200);
  });

  it('purge only works from the trash and is still in the audit trail afterwards', async () => {
    const doc = await upload(A);
    await as(t, A).delete(`/api/documents/${doc}`).expect(400);
    await as(t, A).post(`/api/documents/${doc}/trash`).expect(204);
    await as(t, A).delete(`/api/documents/${doc}`).expect(204);
    await as(t, A).get(`/api/documents/${doc}`).expect(404);
    const trail = await auditRows(`document_id = $1`, [doc]);
    expect(trail.map((r) => r.action)).toEqual(expect.arrayContaining(['document.upload', 'document.trash', 'document.purge']));
  });

  it('transfer: the new owner gets everything, the old owner keeps nothing', async () => {
    const doc = await upload(A);
    await as(t, A).post(`/api/documents/${doc}/transfer`, { newOwnerId: V.userId }).expect(400); // viewer cannot own
    await as(t, A).post(`/api/documents/${doc}/transfer`, { newOwnerId: B.userId }).expect(200);
    await as(t, A).get(`/api/documents/${doc}`).expect(404);
    const res = await as(t, B).get(`/api/documents/${doc}`).expect(200);
    expect(res.body.isOwner).toBe(true);
  });
});

describe('uploads are validated by content, not by name', () => {
  const cases: [string, Buffer, string][] = [
    ['HTML disguised as PDF', Buffer.from('<html><script>alert(1)</script></html>'), 'invoice.pdf'],
    ['SVG with script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png'],
    ['Windows executable', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]), 'report.docx'],
    ['PDF with JavaScript', Buffer.from('%PDF-1.4\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj\n%%EOF'), 'ok.pdf'],
    ['binary with NUL bytes as .txt', Buffer.from([0x41, 0x00, 0x42, 0x00]), 'notes.txt'],
    ['empty file', Buffer.alloc(0), 'empty.pdf'],
    ['plain ZIP archive', zip(['readme.txt']), 'files.zip'],
    ['macro-enabled Word file', zip(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']), 'contract.docx'],
    ['ZIP with path traversal', zip(['[Content_Types].xml', '../../etc/passwd']), 'x.docx'],
  ];

  for (const [name, body, fileName] of cases) {
    it(`refuses ${name}`, async () => {
      const res = await as(t, A).upload('/api/documents', body, fileName, { title: 't', category: 'c' });
      expect(res.status).toBe(400);
    });
  }

  it('accepts a real Word document and stores the detected type, not the claimed one', async () => {
    const docx = zip(['[Content_Types].xml', 'word/document.xml', '_rels/.rels']);
    const id = await upload(A, 'Contract', docx, 'contract.pdf', 'Legal');
    const res = await as(t, A).get(`/api/documents/${id}`);
    expect(res.body.current.mimeType).toContain('wordprocessingml');
    expect(res.body.current.fileName).toBe('contract.docx');
  });

  it('strips directories and control characters from file names', async () => {
    // (Raw control characters cannot even travel in a multipart header, so
    // test the characters that can: path separators and reserved symbols.)
    const id = await upload(A, 'T', PDF, '..\\..\\evil:na|me?.pdf');
    const res = await as(t, A).get(`/api/documents/${id}`);
    expect(res.body.current.fileName).toBe('evilname.pdf');
  });

  it('refuses files over the size limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024, 0x20)]);
    const res = await as(t, A).upload('/api/documents', big, 'big.pdf', { title: 't', category: 'c' });
    expect(res.status).toBe(413);
  });
});

describe('uploads are scanned for malware, and the scanner fails closed', () => {
  const docCount = () => withDb(ownerDb(), async (db) => Number((await db.query('SELECT count(*) FROM documents')).rows[0].count));
  const withMode = async (mode: typeof t.clamd.mode, fn: () => Promise<void>) => {
    t.clamd.mode = mode;
    try { await fn(); } finally { t.clamd.mode = 'normal'; }
  };

  it('every accepted upload went through the scanner (a PDF twice: as received and as rebuilt)', async () => {
    let before = t.clamd.scans;
    await upload(A);
    expect(t.clamd.scans).toBe(before + 2);
    before = t.clamd.scans;
    await upload(A, 'Notes', Buffer.from('hello\n'), 'notes.txt');
    expect(t.clamd.scans).toBe(before + 1);
  });

  it('refuses an infected file, stores nothing, and records the signature', async () => {
    const res = await as(t, A).upload('/api/documents', Buffer.from(EICAR), 'notes.txt', { title: 'Totally fine', category: 'c' });
    expect(res.status).toBe(422);
    expect(await docCount()).toBe(0);
    const rows = await auditRows(`action = 'document.upload' AND reason = 'malware_detected' AND actor_id = $1`, [alice.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('DENIED');
    expect((rows[0]!.details as { signature: string }).signature).toBe('Eicar-Test-Signature');
  });

  it('refuses an infected new version from an editor, and keeps the old version current', async () => {
    const id = await upload(A);
    expect((await grant(A, id, { userId: V.userId, level: 'EDIT' })).status).toBe(200);
    const res = await as(t, V).upload(`/api/documents/${id}/versions`, Buffer.from(EICAR), 'v2.txt');
    expect(res.status).toBe(422);
    expect((await as(t, A).get(`/api/documents/${id}`)).body.current.versionNo).toBe(1);
  });

  it('does not scan for someone with no access: they get 404 before the scanner is used', async () => {
    const id = await upload(A);
    const before = t.clamd.scans;
    const res = await as(t, B).upload(`/api/documents/${id}/versions`, Buffer.from(EICAR), 'v2.txt');
    expect(res.status).toBe(404);
    expect(t.clamd.scans).toBe(before);
  });

  for (const [mode, what] of [['down', 'refuses connections'], ['garbage', 'gives an unexpected answer'], ['silent', 'never answers']] as const) {
    it(`refuses every upload when the scanner ${what}`, async () => {
      await withMode(mode, async () => {
        const res = await as(t, A).upload('/api/documents', PDF, 'clean.pdf', { title: 'Clean', category: 'c' });
        expect(res.status).toBe(503);
      });
      expect(await docCount()).toBe(0);
      const rows = await auditRows(`action = 'document.upload' AND reason = 'malware_scanner_unavailable' AND actor_id = $1`, [alice.id]);
      expect(rows.at(-1)!.outcome).toBe('FAILED');
    });
  }
});

describe('downloads cannot run as a page, and files are encrypted at rest', () => {
  it('sends attachment, nosniff, a sandboxing CSP and no-store', async () => {
    const doc = await upload(A, 'Notes', Buffer.from('hello\n'), 'notes.txt');
    const res = await as(t, A).get(`/api/documents/${doc}/download`);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('the database holds only ciphertext', async () => {
    const secret = Buffer.from('THE-PLAINTEXT-MARKER-12345\n');
    await upload(A, 'Marker', secret, 'marker.txt');
    const rows = await withDb(ownerDb(), (db) => db.query(`SELECT ciphertext FROM document_blobs`));
    for (const r of rows.rows) expect((r.ciphertext as Buffer).includes(secret.subarray(0, 20))).toBe(false);
  });

  it('a blob moved to another document fails its integrity check instead of serving the wrong file', async () => {
    const d1 = await upload(A, 'One', Buffer.from('file one\n'), 'one.txt');
    const d2 = await upload(A, 'Two', Buffer.from('file two\n'), 'two.txt');
    // Attacker with database write access swaps the encrypted bytes.
    await withDb(ownerDb(), (db) => db.query(`
      UPDATE document_blobs b SET wrapped_key = s.wrapped_key, nonce = s.nonce, auth_tag = s.auth_tag, ciphertext = s.ciphertext
        FROM document_blobs s JOIN document_versions sv ON sv.id = s.version_id
       WHERE sv.document_id = $1 AND b.version_id = (SELECT id FROM document_versions WHERE document_id = $2)`, [d1, d2]));
    const res = await as(t, A).get(`/api/documents/${d2}/download`);
    expect(res.status).toBe(500);
    const rows = await auditRows(`document_id = $1 AND action = 'document.integrity'`, [d2]);
    expect(rows[0]).toMatchObject({ outcome: 'FAILED', reason: 'decryption_failed' });
  });
});

describe('the audit trail proves who reached a document', () => {
  it('records upload, view, download, edit, grant, revoke, trash with the actor', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'READ' }).expect(200);
    const g = await grant(A, doc, { userId: V.userId, level: 'EDIT' }).expect(200); // change, not a new grant
    await as(t, V).get(`/api/documents/${doc}/download`).expect(200);
    await as(t, V).patch(`/api/documents/${doc}`, { title: 'Edited' }).expect(200);
    await as(t, V).upload(`/api/documents/${doc}/versions`, PDF, 'v2.pdf').expect(201);
    await as(t, A).delete(`/api/documents/${doc}/access/${g.body.id}`).expect(200);
    await as(t, A).post(`/api/documents/${doc}/trash`).expect(204);
    const trail = await auditRows(`document_id = $1 AND outcome = 'ALLOWED'`, [doc]);
    const seen = trail.map((r) => `${r.action}:${r.actor_email}`);
    expect(seen).toEqual(expect.arrayContaining([
      'document.upload:alice@t.io', 'access.grant:alice@t.io', 'access.change:alice@t.io', 'document.download:victor@t.io',
      'document.edit:victor@t.io', 'document.upload_version:victor@t.io', 'access.revoke:alice@t.io', 'document.trash:alice@t.io',
    ]));
  });

  it('history is visible to managers, not to readers', async () => {
    const doc = await upload(A);
    await grant(A, doc, { userId: V.userId, level: 'READ' });
    await as(t, V).get(`/api/documents/${doc}/history`).expect(404);
    const res = await as(t, A).get(`/api/documents/${doc}/history`).expect(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });
});

describe('admins cannot read documents, except through audited break-glass', () => {
  it('break-glass gives one hour of VIEW (pages, no download), is audited with the reason, and shows as an alert', async () => {
    const doc = await upload(A, 'Notes', Buffer.from('incident notes\n'), 'notes.txt');
    await as(t, ADM).get(`/api/documents/${doc}`).expect(404);
    // A second admin approves the request first (THREATS.md S19).
    const ADM2 = await login(t, await createUser({ email: 'admin2@t.io', role: 'ADMIN' }));
    await as(t, ADM).post('/api/admin/approvals', { action: 'BREAK_GLASS', documentId: doc, reason: 'short' }).expect(400);
    const ok = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: doc, reason: 'Legal hold request #4471 from counsel' });
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId: ok }).expect(201);
    await as(t, ADM).get(`/api/documents/${doc}`).expect(200);
    await as(t, ADM).get(`/api/documents/${doc}/pages/1`).expect(200);
    // An emergency look, never the original file (THREATS.md V9).
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, ADM).patch(`/api/documents/${doc}`, { title: 'x' }).expect(404); // VIEW only
    const alerts = await as(t, ADM).get('/api/admin/alerts').expect(200);
    expect(alerts.body.alerts.some((a: { kind: string }) => a.kind === 'break_glass')).toBe(true);
    const history = await as(t, A).get(`/api/documents/${doc}/history`);
    expect(history.body.events.some((e: { action: string }) => e.action === 'admin.break_glass')).toBe(true);
  });

  it('non-admins cannot use break-glass', async () => {
    const doc = await upload(A);
    await as(t, B).post('/api/admin/break-glass', { documentId: doc, approvalId: '6f1c2c1e-6c51-4c8e-9a51-2b6f5a1d9e01' }).expect(403);
    await as(t, B).post('/api/admin/approvals', { action: 'BREAK_GLASS', documentId: doc, reason: 'I would like to read this one please' }).expect(403);
  });
});

describe('access suggestions never widen access by themselves', () => {
  it('suggests people from similar documents, grants nothing, and audits the suggestion', async () => {
    const d1 = await upload(A, 'Payroll Jan', PDF, 'a.pdf', 'Payroll');
    await grant(A, d1, { userId: V.userId, level: 'READ' }).expect(200);
    const d2 = await upload(A, 'Payroll Feb', PDF, 'b.pdf', 'Payroll');
    const res = await as(t, A).get(`/api/documents/${d2}/suggestions`).expect(200);
    expect(res.body.suggestions.map((s: { id: string }) => s.id)).toContain(V.userId);
    await as(t, V).get(`/api/documents/${d2}`).expect(404); // still no access
    await grant(A, d2, { userId: V.userId, level: 'READ', fromSuggestion: true }).expect(200);
    const rows = await auditRows(`document_id = $1 AND action IN ('access.suggest', 'access.grant')`, [d2]);
    expect(rows.map((r) => r.action)).toEqual(['access.suggest', 'access.grant']);
    expect((rows[1]!.details as { source: string }).source).toBe('suggestion_confirmed_by_owner');
  });
});

describe('the browser cannot be used against a signed-in user', () => {
  it('a cross-site upload is refused even with a valid session', async () => {
    const res = await t.http.post('/api/documents').set('Cookie', A.cookie).set('Origin', 'https://evil.example').set('X-CSRF-Token', A.csrf)
      .attach('file', PDF, 'x.pdf').field('title', 't').field('category', 'c');
    expect(res.status).toBe(403);
  });
});

/** Builds a minimal ZIP containing empty entries with the given names (central directory only matters). */
function zip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

void appDb; void ORIGIN;

describe('folder counts', () => {
  it('do not count documents in the trash', async () => {
    const folder = (await as(t, A).post('/api/folders', { name: 'Contracts' }).expect(201)).body.id as string;
    const d1 = await upload(A, 'One');
    const d2 = await upload(A, 'Two');
    for (const d of [d1, d2]) await as(t, A).patch(`/api/documents/${d}`, { folderId: folder }).expect(200);
    const count = async () => (await as(t, A).get('/api/folders').expect(200)).body.folders.find((f: { id: string }) => f.id === folder).documents;
    expect(await count()).toBe(2);
    await as(t, A).post(`/api/documents/${d2}/trash`).expect(200);
    expect(await count()).toBe(1);
  });
});
