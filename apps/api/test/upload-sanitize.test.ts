import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { as, auditRows, createUser, login, ownerDb, PDF, resetState, startApp, withDb, type Session, type TestApp, type TestUser } from './helpers.js';
import { strictPdfCheck } from '../src/documents/content-check.js';
import { INSPECTOR_LIMITS } from '../src/documents/content-inspector.js';
import { UPLOAD_REFUSAL_AUDIT_LIMIT } from '../src/documents/documents.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import * as B from './fixtures/hostile/build.js';

// THREATS.md C9-C11 (PDF sanitization) and the refused-upload audit rows:
// every PDF is stored as a rebuilt copy; every refused upload or new
// version leaves exactly one audit row saying why, with what was received.

let t: TestApp;
let alice: TestUser;
let A: Session, E: Session, S: Session;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetState(t.app);
  alice = await createUser({ email: 'san-alice@t.io', role: 'OWNER' });
  const editor = await createUser({ email: 'san-editor@t.io', role: 'OWNER' });
  const stranger = await createUser({ email: 'san-stranger@t.io', role: 'OWNER' });
  [A, E, S] = await Promise.all([login(t, alice), login(t, editor), login(t, stranger)]);
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rowsFor = (res: { headers: Record<string, unknown> }) => auditRows('request_id = $1', [res.headers['x-request-id']]);
const docCount = async () => (await withDb(ownerDb(), (c) => c.query('SELECT count(*)::int AS n FROM documents WHERE owner_id = $1', [alice.id]))).rows[0].n as number;
const bytes = (r: ReturnType<ReturnType<typeof as>['get']>) =>
  r.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

/** A one-page PDF with text, a JavaScript OpenAction and an embedded file. */
async function activePdf(text = 'Board minutes, page one'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText(text, { x: 20, y: 250, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  const js = doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.launchURL("https://evil.example/")') }));
  doc.catalog.set(PDFName.of('OpenAction'), js);
  // An embedded file, stored uncompressed so a scanner signature can match it in the raw upload.
  const ctx = doc.context;
  const file = ctx.register(ctx.stream('ATTACHED-PAYLOAD-7f3a', { Type: 'EmbeddedFile' }));
  const spec = ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of('payload.bin'), EF: { F: file } }));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ EmbeddedFiles: ctx.obj({ Names: [PDFString.of('payload.bin'), spec] }) }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

describe('PDFs are stored as a sanitized copy', () => {
  it('removes active content, says so, stores and audits the rebuilt file; download and page view work', async () => {
    const input = await activePdf();
    const scans = t.clamd.scans;
    const res = await as(t, A).upload('/api/documents', input, 'Board minutes.pdf', { title: 'Minutes', category: 'Board' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.sanitized).toEqual({ removed: ['EmbeddedFiles', 'JavaScript', 'OpenAction'] });
    // Both the upload as received and the rebuilt copy went through the scanner.
    expect(t.clamd.scans).toBe(scans + 2);
    const id = res.body.id as string;

    const meta = (await as(t, A).get(`/api/documents/${id}`)).body;
    expect(meta.versions[0].fileName).toBe('Board minutes.pdf'); // original name kept
    expect(meta.versions[0].sha256).not.toBe(sha(input)); // a new file

    // The stored bytes are the rebuilt copy: download the unstamped hash anchor and check it.
    const stored = await withDb(ownerDb(), async (c) => (await c.query('SELECT encode(sha256, \'hex\') AS h, size_bytes FROM document_versions WHERE document_id = $1', [id])).rows[0]);
    expect(stored.h).toBe(meta.versions[0].sha256);

    const [row] = await auditRows(`document_id = $1 AND action = 'document.upload' AND outcome = 'ALLOWED'`, [id]);
    expect(row!.details).toMatchObject({
      fileName: 'Board minutes.pdf', sha256: stored.h, sizeBytes: stored.size_bytes,
      sanitized: { originalSha256: sha(input), originalSizeBytes: input.length, sanitizedSha256: stored.h, sanitizedSizeBytes: stored.size_bytes, removed: ['EmbeddedFiles', 'JavaScript', 'OpenAction'] },
    });

    // Download (stamped) works and is itself clean.
    const dl = await bytes(as(t, A).get(`/api/documents/${id}/download`));
    expect(dl.status).toBe(200);
    expect(dl.headers['x-document-sha256']).toBe(stored.h);
    expect(dl.headers['x-stamped']).toBe('yes');
    const out = dl.body as Buffer;
    expect(out.toString('latin1')).not.toContain('ATTACHED-PAYLOAD');
    await strictPdfCheck(out);
    // Page rendering works on the sanitized file.
    expect((await as(t, A).get(`/api/documents/${id}/pages`)).body).toMatchObject({ pages: 1 });
    const png = await bytes(as(t, A).get(`/api/documents/${id}/pages/1`));
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');

    // The history (owner) shows the row with what was removed.
    const history = (await as(t, A).get(`/api/documents/${id}/history`)).body.events as { action: string; details: { sanitized?: { removed: string[] } } }[];
    expect(history.find((e) => e.action === 'document.upload')!.details.sanitized!.removed).toContain('JavaScript');
  });

  it('a new version is sanitized the same way', async () => {
    const id = (await as(t, A).upload('/api/documents', Buffer.from('v1\n'), 'notes.txt', { title: 'N', category: 'c' })).body.id as string;
    const input = await activePdf('Version two');
    const res = await as(t, A).upload(`/api/documents/${id}/versions`, input, 'v2.pdf');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ versionNo: 2, sanitized: { removed: ['EmbeddedFiles', 'JavaScript', 'OpenAction'] } });
    const [row] = await auditRows(`document_id = $1 AND action = 'document.upload_version' AND outcome = 'ALLOWED'`, [id]);
    expect((row!.details as { sanitized: { originalSha256: string } }).sanitized.originalSha256).toBe(sha(input));
  });

  it('a clean PDF is rebuilt with nothing to report; other files are stored as sent', async () => {
    const pdf = await as(t, A).upload('/api/documents', B.pdf(), 'clean.pdf', { title: 'p', category: 'c' });
    expect(pdf.body.sanitized).toEqual({ removed: [] });
    const txt = await as(t, A).upload('/api/documents', Buffer.from('hello\n'), 'a.txt', { title: 't', category: 'c' });
    expect(txt.body.sanitized).toBeNull();
    const [row] = await auditRows(`document_id = $1 AND action = 'document.upload'`, [txt.body.id]);
    expect(row!.details).not.toHaveProperty('sanitized');
    expect((row!.details as { sha256: string }).sha256).toBe(sha(Buffer.from('hello\n')));
  });

  it('malware in the upload as received is refused even though the rebuild would have dropped it', async () => {
    t.clamd.signatures.set('ATTACHED-PAYLOAD-7f3a', 'Test.Attachment.Payload');
    try {
      const res = await as(t, A).upload('/api/documents', await activePdf(), 'm.pdf', { title: 'm', category: 'c' });
      expect(res.status).toBe(422);
      const rows = await rowsFor(res);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'document.upload', outcome: 'DENIED', reason: 'malware_detected' });
      expect(rows[0]!.details).toMatchObject({ scanned: 'original', signature: 'Test.Attachment.Payload' });
    } finally {
      t.clamd.signatures.clear();
    }
    expect(await docCount()).toBe(0);
  });
});

describe('every refused upload leaves one audit row', () => {
  const expectRefusal = async (res: { status: number; headers: Record<string, unknown> }, status: number, want: Record<string, unknown>, details: Record<string, unknown> = {}) => {
    expect(res.status).toBe(status);
    const rows = await rowsFor(res);
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.upload', outcome: 'DENIED', actor_id: alice.id, ...want });
    expect(rows[0]!.details).toMatchObject(details);
    expect(typeof (rows[0]!.details as { message: string }).message).toBe('string');
    return rows[0]!;
  };

  it('content_rejected: a polyglot, an Office macro file, an encrypted PDF', async () => {
    const cases: [Buffer, string][] = [
      [Buffer.concat([B.png(), Buffer.from('<html><script>alert(1)</script></html>')]), 'a.png'],
      [B.docx({ extra: [{ name: 'word/vbaProject.bin', data: 'x' }] }), 'a.docx'],
      [B.pdf({ trailerExtra: '/Encrypt<</Filter/Standard/V 2/R 3/O(x)/U(y)/P -4>>' }), 'locked.pdf'],
    ];
    for (const [body, name] of cases) {
      const scans = t.clamd.scans;
      const res = await as(t, A).upload('/api/documents', body, name, { title: 't', category: 'c' });
      await expectRefusal(res, 400, { reason: 'content_rejected' }, { fileName: name, sizeBytes: body.length, sha256: sha(body) });
      expect(t.clamd.scans).toBe(scans);
    }
    expect(await docCount()).toBe(0);
  });

  it('type_not_allowed: an executable, an HTML file', async () => {
    for (const [body, name] of [[Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), 'setup.exe'], [Buffer.from('<!doctype html><script>1</script>'), 'a.html']] as const) {
      await expectRefusal(await as(t, A).upload('/api/documents', body, name, { title: 't', category: 'c' }), 400, { reason: 'type_not_allowed' }, { fileName: name, sha256: sha(body) });
    }
  });

  it('sanitize_failed: a PDF whose rebuilt copy still fails the strict check is refused, and the original is not stored', async () => {
    const p = B.pdf({ pageExtra: '/Contents 4 0 R', extra: [B.streamObj(4, '', Buffer.from('BT /F1 12 Tf (/JavaScript) Tj ET'))] });
    const res = await as(t, A).upload('/api/documents', p, 'odd.pdf', { title: 't', category: 'c' });
    await expectRefusal(res, 400, { reason: 'sanitize_failed' }, { fileName: 'odd.pdf', sha256: sha(p), sizeBytes: p.length });
    expect(res.body.code).toBe('sanitize_failed');
    expect(await docCount()).toBe(0);
  });

  it('check_failed: the check ran out of time', async () => {
    const saved = INSPECTOR_LIMITS.timeoutMs;
    INSPECTOR_LIMITS.timeoutMs = 30;
    try {
      const heavy = B.pdf({ extra: [B.objStm(4, Array.from({ length: 60_000 }, (_, i) => ({ num: 10 + i, body: '<</A[1 2 3]>>' })))] });
      await expectRefusal(await as(t, A).upload('/api/documents', heavy, 'slow.pdf', { title: 't', category: 'c' }), 400, { reason: 'check_failed' }, { sha256: sha(heavy) });
    } finally {
      INSPECTOR_LIMITS.timeoutMs = saved;
    }
  });

  it('no_file, invalid_input (bad form fields), too_large', async () => {
    const noFile = await as(t, A).post('/api/documents', { title: 't', category: 'c' });
    await expectRefusal(noFile, 400, { reason: 'no_file' }, { fileName: null, sha256: null });
    await expectRefusal(await as(t, A).upload('/api/documents', PDF, 'a.pdf', { category: 'c' }), 400, { reason: 'invalid_input' }, { fileName: 'a.pdf', sha256: sha(PDF), status: 400 });
    const big = Buffer.concat([PDF, Buffer.alloc(26 * 1024 * 1024, 0x20)]);
    const row = await expectRefusal(await as(t, A).upload('/api/documents', big, 'big.pdf', { title: 't', category: 'c' }), 413, { reason: 'too_large' }, { status: 413 });
    expect((row.details as { sizeBytes: number }).sizeBytes).toBeGreaterThan(25 * 1024 * 1024);
  });

  it('rate_limited', async () => {
    await t.app.get(RedisService).client.set(`rl:upload:${alice.id}`, '60', 'EX', 600);
    await expectRefusal(await as(t, A).upload('/api/documents', PDF, 'a.pdf', { title: 't', category: 'c' }), 429, { reason: 'rate_limited' }, { fileName: 'a.pdf' });
  });

  it('new versions: an editor’s refused file is recorded on the document; a stranger only gets the access refusal', async () => {
    const id = (await as(t, A).upload('/api/documents', Buffer.from('v1\n'), 'notes.txt', { title: 'N', category: 'c' })).body.id as string;
    expect((await as(t, A).put(`/api/documents/${id}/access`, { userId: E.userId, level: 'EDIT' })).status).toBe(200);
    const bad = Buffer.concat([B.png(), Buffer.from('<html>')]);
    const res = await as(t, E).upload(`/api/documents/${id}/versions`, bad, 'v2.png');
    expect(res.status).toBe(400);
    const rows = await rowsFor(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.upload_version', outcome: 'DENIED', reason: 'content_rejected', document_id: id, actor_id: E.userId });
    expect(rows[0]!.details).toMatchObject({ fileName: 'v2.png', sha256: sha(bad) });

    const scans = t.clamd.scans;
    const res2 = await as(t, S).upload(`/api/documents/${id}/versions`, bad, 'v2.png');
    expect(res2.status).toBe(404);
    const rows2 = await rowsFor(res2);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]).toMatchObject({ action: 'document.upload_version', outcome: 'DENIED', reason: 'no_grant', actor_id: S.userId });
    expect(t.clamd.scans).toBe(scans);
  });

  it('the rows are bounded per person: one marker row, then nothing until the window ends', async () => {
    await t.app.get(RedisService).client.set(`auditrefusal:upload:${alice.id}`, String(UPLOAD_REFUSAL_AUDIT_LIMIT), 'EX', 600);
    const first = await as(t, A).post('/api/documents', { title: 't', category: 'c' });
    expect(first.status).toBe(400);
    const rows = await rowsFor(first);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'document.upload', reason: 'refusal_audit_suppressed' });
    expect(rows[0]!.details).toMatchObject({ refusedReason: 'no_file', limitPer10Minutes: UPLOAD_REFUSAL_AUDIT_LIMIT });
    const second = await as(t, A).post('/api/documents', { title: 't', category: 'c' });
    expect(second.status).toBe(400);
    expect(await rowsFor(second)).toHaveLength(0);
  });

  it('a long file name is clipped in the row', async () => {
    const name = `${'x'.repeat(400)}.exe`;
    const row = await expectRefusal(await as(t, A).upload('/api/documents', Buffer.from('MZ\0\0', 'latin1'), name, { title: 't', category: 'c' }), 400, { reason: 'type_not_allowed' });
    expect((row.details as { fileName: string }).fileName).toHaveLength(200);
  });
});
