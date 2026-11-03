import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { appDb, approved, as, auditRows, createUser, login, ownerDb, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';

// View-only access and leak tracing (THREATS.md V1-V10): a VIEW grantee
// sees watermarked page images and never the original file, in either
// lock; every page and every download carries a trace code that is in the
// audit log; revocation stops pages and the Android key at once.

let t: TestApp;
let alice: TestUser, victor: TestUser, rita: TestUser, erin: TestUser, admin: TestUser;
let A: Session, V: Session, R: Session, E: Session, ADM: Session;

beforeAll(async () => {
  // Low alert thresholds so a test can trip them; a rate limit a test can reach.
  t = await startApp({ PAGE_VIEW_ALERT_PAGES: '5', PAGE_VIEW_ALERT_DOCUMENTS: '50', PAGE_VIEW_RATE_LIMIT: '30' });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'alice@v.io', role: 'OWNER' });
  victor = await createUser({ email: 'victor@v.io', role: 'VIEWER' });
  rita = await createUser({ email: 'rita@v.io', role: 'VIEWER' });
  erin = await createUser({ email: 'erin@partner.io', role: 'EXTERNAL' });
  admin = await createUser({ email: 'admin@v.io', role: 'ADMIN' });
  [A, V, R, E, ADM] = await Promise.all([login(t, alice), login(t, victor), login(t, rita), login(t, erin), login(t, admin)]);
});

async function twoPagePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const n of [1, 2]) pdf.addPage([595, 842]).drawText(`Board minutes page ${n}`, { x: 60, y: 760, size: 24, font });
  return Buffer.from(await pdf.save());
}

function png(): Buffer {
  const c = createCanvas(320, 200);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2050a0';
  ctx.fillRect(0, 0, 320, 200);
  return c.toBuffer('image/png');
}

async function upload(s: Session, body: Buffer, name: string, title = 'Board minutes') {
  const res = await as(t, s).upload('/api/documents', body, name, { title, category: 'Board' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const grant = (s: Session, doc: string, body: object) => as(t, s).put(`/api/documents/${doc}/access`, body);

/** Raw body bytes (supertest only buffers text and JSON by default). */
const bytes = (r: request.Test) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

async function pdfText(data: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ');
  await task.destroy();
  return text;
}

describe('VIEW: pages yes, original bytes no (THREATS.md V1, V2)', () => {
  it('a VIEW grantee can find, open and page through a document, but every route to the original is refused', async () => {
    const original = await twoPagePdf();
    const doc = await upload(A, original, 'minutes.pdf');
    await grant(A, doc, { userId: victor.id, level: 'VIEW' }).expect(200);

    const found = await as(t, V).get('/api/documents?q=minutes').expect(200);
    expect(found.body.documents.map((d: { id: string; myAccess: string }) => [d.id, d.myAccess])).toEqual([[doc, 'VIEW']]);
    const meta = await as(t, V).get(`/api/documents/${doc}`).expect(200);
    expect(meta.body.myAccess).toBe('VIEW');

    expect((await as(t, V).get(`/api/documents/${doc}/pages`).expect(200)).body).toMatchObject({ pages: 2, preview: true, versionNo: 1 });
    const page = await bytes(as(t, V).get(`/api/documents/${doc}/pages/2`)).expect(200);
    expect(page.headers['content-type']).toBe('image/png');
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    const body = page.body as Buffer;
    expect(body.subarray(1, 4).toString()).toBe('PNG');
    expect(body.includes(Buffer.from('%PDF'))).toBe(false);
    await as(t, V).get(`/api/documents/${doc}/pages/3`).expect(404);

    // The original file: refused by decide() (and audited) on every route.
    for (const path of ['download', 'versions/1/download']) {
      await as(t, V).get(`/api/documents/${doc}/${path}`).expect(404);
    }
    await as(t, V).post(`/api/documents/${doc}/offline-key`).expect(404);
    const refused = await auditRows(`document_id = $1 AND actor_id = $2 AND outcome = 'DENIED' AND action <> 'document.request_refused'`, [doc, victor.id]);
    expect(refused.map((r) => `${r.action}:${r.reason}`)).toEqual([
      'document.download:needs_read', 'document.download:needs_read', 'document.offline_key:needs_read',
    ]);
  });

  it('the database alone refuses the original to a VIEW grantee, whatever the app asks', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    await grant(A, doc, { userId: victor.id, level: 'VIEW' }).expect(200);
    // As the app's database role, in victor's name, with no API code involved.
    await withDb(appDb(), async (db) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.user_id', $1, true)`, [victor.id]);
      expect((await db.query(`SELECT 1 FROM documents WHERE id = $1`, [doc])).rowCount).toBe(1);
      expect((await db.query(`SELECT 1 FROM document_blobs b JOIN document_versions v ON v.id = b.version_id WHERE v.document_id = $1`, [doc])).rowCount).toBe(0);
      await db.query('ROLLBACK');
    });
  });

  it('pages of an image and of a text file are drawn; Word files say why they are not', async () => {
    const img = await upload(A, png(), 'chart.png', 'Chart');
    const txt = await upload(A, Buffer.from('line one\nline two\n'), 'notes.txt', 'Notes');
    const docx = await upload(A, wordFile(), 'contract.docx', 'Contract');
    for (const d of [img, txt]) {
      await grant(A, d, { userId: victor.id, level: 'VIEW' }).expect(200);
      expect((await as(t, V).get(`/api/documents/${d}/pages`).expect(200)).body.pages).toBe(1);
      const p = await bytes(as(t, V).get(`/api/documents/${d}/pages/1`)).expect(200);
      expect(p.headers['content-type']).toBe('image/png');
    }
    // No converter on the server: say so, and point at the owner (THREATS.md V2).
    await grant(A, docx, { userId: victor.id, level: 'VIEW' }).expect(200);
    const none = await as(t, V).get(`/api/documents/${docx}/pages`).expect(200);
    expect(none.body).toMatchObject({ pages: 0, preview: false });
    expect(none.body.message).toMatch(/ask the owner for download access/i);
    await as(t, V).get(`/api/documents/${docx}/pages/1`).expect(422);
  });
});

describe('watermarks and trace codes (THREATS.md V3, V4)', () => {
  it('every page carries the viewer and a trace code that is in that page view’s audit row', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    await grant(A, doc, { userId: victor.id, level: 'VIEW' }).expect(200);
    await grant(A, doc, { userId: rita.id, level: 'VIEW' }).expect(200);

    const v1 = await bytes(as(t, V).get(`/api/documents/${doc}/pages/1`)).expect(200);
    const v2 = await bytes(as(t, V).get(`/api/documents/${doc}/pages/1`)).expect(200);
    const r1 = await bytes(as(t, R).get(`/api/documents/${doc}/pages/1`)).expect(200);
    const traces = [v1, v2, r1].map((r) => r.headers['x-trace-code'] as string);
    for (const code of traces) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(traces).size).toBe(3);

    // Same page, different viewer or moment: different picture (the mark differs).
    expect((v1.body as Buffer).equals(r1.body as Buffer)).toBe(false);
    expect((v1.body as Buffer).equals(v2.body as Buffer)).toBe(false);

    // A leaked screenshot's code leads to one person, one page, one moment.
    const rows = await auditRows(`action = 'document.page_view' AND document_id = $1 AND outcome = 'ALLOWED'`, [doc]);
    const byTrace = new Map(rows.map((r) => [(r.details as { trace: string }).trace, r]));
    expect(byTrace.get(traces[0]!)).toMatchObject({ actor_email: 'victor@v.io', details: expect.objectContaining({ page: 1, versionNo: 1 }) });
    expect(byTrace.get(traces[2]!)).toMatchObject({ actor_email: 'rita@v.io' });
  });

  it('a downloaded PDF is stamped with who, when and a trace code that is in the download’s audit row (THREATS.md V5)', async () => {
    const original = await twoPagePdf();
    const doc = await upload(A, original, 'minutes.pdf');
    await grant(A, doc, { userId: victor.id, level: 'READ' }).expect(200);
    const dl = await bytes(as(t, V).get(`/api/documents/${doc}/download`)).expect(200);
    const data = dl.body as Buffer;
    expect(data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(data.equals(original)).toBe(false);
    expect(dl.headers['x-stamped']).toBe('yes');
    const trace = dl.headers['x-trace-code'] as string;
    const text = await pdfText(data);
    expect(text).toContain('victor@v.io');
    expect(text).toContain(trace);
    const [row] = await auditRows(`action = 'document.download' AND document_id = $1 AND outcome = 'ALLOWED'`, [doc]);
    expect(row!.details).toMatchObject({ trace, stamp: 'pdf' });
  });

  it('a downloaded image is stamped; a text file goes out unchanged and the record says so', async () => {
    const image = png();
    const img = await upload(A, image, 'chart.png', 'Chart');
    const txtBody = Buffer.from('plain notes\n');
    const txt = await upload(A, txtBody, 'notes.txt', 'Notes');
    const di = await bytes(as(t, A).get(`/api/documents/${img}/download`)).expect(200);
    expect(di.headers['content-type']).toBe('image/png');
    expect((di.body as Buffer).equals(image)).toBe(false);
    expect(di.headers['x-stamped']).toBe('yes');
    const dt = await bytes(as(t, A).get(`/api/documents/${txt}/download`)).expect(200);
    expect((dt.body as Buffer).equals(txtBody)).toBe(true);
    expect(dt.headers['x-stamped']).toBe('no');
    const [row] = await auditRows(`action = 'document.download' AND document_id = $1`, [txt]);
    expect(row!.details).toMatchObject({ stamp: 'none', trace: dt.headers['x-trace-code'] });
  });
});

describe('revocation stops pages and the Android key at once (THREATS.md V6)', () => {
  it('after a revoke: pages refused on the next request, the offline key refused and destroyed', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    const gv = await grant(A, doc, { userId: victor.id, level: 'VIEW' }).expect(200);
    const gr = await grant(A, doc, { userId: rita.id, level: 'READ' }).expect(200);
    await as(t, V).get(`/api/documents/${doc}/pages/1`).expect(200);

    const k1 = await as(t, R).post(`/api/documents/${doc}/offline-key`).expect(200);
    const k2 = await as(t, R).post(`/api/documents/${doc}/offline-key`).expect(200);
    expect(Buffer.from(k1.body.key, 'base64')).toHaveLength(32);
    expect(k2.body.key).toBe(k1.body.key); // the same key on every open while access lasts

    await as(t, A).delete(`/api/documents/${doc}/access/${gv.body.id}`).expect(200);
    await as(t, A).delete(`/api/documents/${doc}/access/${gr.body.id}`).expect(200);
    await as(t, V).get(`/api/documents/${doc}/pages`).expect(404);
    await as(t, V).get(`/api/documents/${doc}/pages/1`).expect(404);
    await as(t, R).post(`/api/documents/${doc}/offline-key`).expect(404);
    const keys = await withDb(ownerDb(), (db) => db.query(`SELECT 1 FROM offline_keys WHERE document_id = $1`, [doc]));
    expect(keys.rowCount).toBe(0);

    // Shared again later: a new key, so a copy kept from before still cannot be opened.
    await grant(A, doc, { userId: rita.id, level: 'READ' }).expect(200);
    const k3 = await as(t, R).post(`/api/documents/${doc}/offline-key`).expect(200);
    expect(k3.body.key).not.toBe(k1.body.key);
    const audited = await auditRows(`action = 'document.offline_key' AND document_id = $1`, [doc]);
    expect(audited.map((r) => r.outcome)).toEqual(['ALLOWED', 'ALLOWED', 'DENIED', 'ALLOWED']);
  });
});

describe('externals and break-glass (THREATS.md V9, V10)', () => {
  it('an external can be given VIEW or READ (with an expiry), nothing more', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await grant(A, doc, { userId: erin.id, level: 'EDIT', expiresAt: soon }).expect(400);
    await grant(A, doc, { userId: erin.id, level: 'VIEW' }).expect(400); // still needs an expiry
    await grant(A, doc, { userId: erin.id, level: 'VIEW', expiresAt: soon }).expect(200);
    await as(t, E).get(`/api/documents/${doc}/pages/1`).expect(200);
    await as(t, E).get(`/api/documents/${doc}/download`).expect(404);
  });

  it('break-glass shows an admin the pages but never the original', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    // A second admin approves first (THREATS.md S19).
    const ADM2 = await login(t, await createUser({ email: 'admin2@v.io', role: 'ADMIN' }));
    const approvalId = await approved(t, ADM, ADM2, { action: 'BREAK_GLASS', documentId: doc, reason: 'Legal hold request #4471 from counsel' });
    await as(t, ADM).post('/api/admin/break-glass', { documentId: doc, approvalId }).expect(201);
    await as(t, ADM).get(`/api/documents/${doc}/pages/1`).expect(200);
    await as(t, ADM).get(`/api/documents/${doc}/download`).expect(404);
    await as(t, ADM).post(`/api/documents/${doc}/offline-key`).expect(404);
  });
});

describe('bulk copying is noticed and slowed (THREATS.md V7)', () => {
  it('many pages in ten minutes raise an alert naming the person', async () => {
    // A fresh address: the audit log (and so the alert window) outlives each test.
    const busy = await createUser({ email: `busy-${Date.now()}@v.io`, role: 'VIEWER' });
    const U = await login(t, busy);
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    await grant(A, doc, { userId: busy.id, level: 'VIEW' }).expect(200);
    for (let i = 0; i < 6; i++) await as(t, U).get(`/api/documents/${doc}/pages/${(i % 2) + 1}`).expect(200);
    const res = await as(t, ADM).get('/api/admin/alerts').expect(200);
    const alert = res.body.alerts.find((a: { kind: string; message: string }) => a.kind === 'bulk_page_views' && a.message.includes(busy.email));
    expect(alert?.message).toContain('viewed 6 pages of 1 document within 10 minutes');
  });

  it('a few pages do not alert', async () => {
    // A fresh address: the audit log (and so the alert window) outlives each test.
    const quiet = await createUser({ email: `quiet-${Date.now()}@v.io`, role: 'VIEWER' });
    const Q = await login(t, quiet);
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    await grant(A, doc, { userId: quiet.id, level: 'VIEW' }).expect(200);
    for (let i = 0; i < 3; i++) await as(t, Q).get(`/api/documents/${doc}/pages/1`).expect(200);
    const res = await as(t, ADM).get('/api/admin/alerts').expect(200);
    expect(res.body.alerts.some((a: { kind: string; message: string }) => a.kind === 'bulk_page_views' && a.message.includes(quiet.email))).toBe(false);
  });

  it('pages are rate limited per person', async () => {
    const doc = await upload(A, await twoPagePdf(), 'minutes.pdf');
    await grant(A, doc, { userId: victor.id, level: 'VIEW' }).expect(200);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await as(t, V).get(`/api/documents/${doc}/pages/1`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  }, 60_000);
});

/** A minimal Word file: a ZIP whose entry names say docx (contents are never unpacked). */
function wordFile(): Buffer {
  const names = ['[Content_Types].xml', 'word/document.xml', '_rels/.rels'];
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
