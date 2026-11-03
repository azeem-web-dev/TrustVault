import { afterAll, describe, expect, it } from 'vitest';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { checkUpload, RejectedFile, strictPdfCheck } from '../src/documents/content-check.js';
import { assertRebuilt } from '../src/documents/pdf-sanitize.js';
import { stopInspector } from '../src/documents/content-inspector.js';
import * as B from './fixtures/hostile/build.js';

// PDF sanitization (THREATS.md C9-C11): every PDF is rebuilt; active
// content is removed, not refused; the rebuilt file must pass the full
// strict check; structural problems are still refused.

afterAll(() => stopInspector());

async function pageText(pdf: Buffer): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await task.destroy();
  return out;
}

/** A realistic two-page report carrying every kind of active content pdf-lib can write. */
async function hostileReport(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Quarterly report');
  doc.setAuthor('Finance');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 300]);
  p1.drawText('Quarterly report page one', { x: 20, y: 250, size: 14, font });
  const p2 = doc.addPage([300, 400]);
  p2.setRotation(degrees(90));
  p2.drawText('Second page text', { x: 20, y: 350, size: 14, font });
  const ctx = doc.context;
  const js = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  // Document level: OpenAction, Names/JavaScript, an embedded file, AA.
  doc.catalog.set(PDFName.of('OpenAction'), js);
  doc.catalog.set(PDFName.of('AA'), ctx.obj({ WC: js }));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: ctx.obj({ Names: [PDFString.of('x'), js] }) }));
  await doc.attach(Buffer.from('MZ evil'), 'payload.exe', { mimeType: 'application/octet-stream' });
  // A form with a text field (AcroForm on the catalog, a widget on page 1).
  doc.getForm().createTextField('name').addToPage(p1, { x: 20, y: 100, width: 120, height: 20 });
  // Page level: AA, a FileAttachment annotation, a Launch link, a file:// link, a safe link.
  p1.node.set(PDFName.of('AA'), ctx.obj({ O: js }));
  const fs = ctx.obj({ Type: 'Filespec', F: PDFString.of('a.exe'), EF: ctx.obj({ F: ctx.register(ctx.stream('MZ', { Type: 'EmbeddedFile' })) }) });
  const annots = [
    ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [0, 0, 10, 10], FS: fs }),
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 20, 10, 30], A: ctx.obj({ S: 'Launch', F: PDFString.of('calc.exe') }) }),
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 40, 10, 50], A: ctx.obj({ S: 'URI', URI: PDFString.of('file:///etc/passwd') }) }),
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 60, 10, 70], A: ctx.obj({ S: 'URI', URI: PDFString.of('https://example.com/') }) }),
    ctx.obj({ Type: 'Annot', Subtype: 'RichMedia', Rect: [0, 80, 10, 90] }),
  ].map((a) => ctx.register(a));
  const existing = p1.node.lookup(PDFName.of('Annots'), PDFArray);
  for (const a of annots) existing.push(a);
  return Buffer.from(await doc.save());
}

describe('PDF sanitization', () => {
  it('removes every kind of active content and keeps the pages, their text, size and rotation', async () => {
    const input = await hostileReport();
    expect(await strictPdfCheck(input).then(() => 'passed', (e: Error) => e.message)).not.toBe('passed');

    const r = await checkUpload(input, 'report.pdf');
    expect(r.type.ext).toBe('pdf');
    const out = r.sanitized!.data;
    expect(r.sanitized!.removed).toEqual([
      'Automatic actions (AA)', 'EmbeddedFiles', 'FileAttachment annotation', 'Form fields (AcroForm)',
      'JavaScript', 'Launch action', 'Non-web link (URI)', 'OpenAction', 'RichMedia/3D/multimedia',
    ]);
    // The re-inspection guard passes, and the output is shaped as we write it.
    await strictPdfCheck(out);
    expect(await assertRebuilt(out)).toBe(2);

    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 400, height: 300 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(doc.getTitle()).toBe('Quarterly report');
    expect(doc.getAuthor()).toBe('Finance');
    for (const key of ['OpenAction', 'AA', 'Names', 'AcroForm']) expect(doc.catalog.has(PDFName.of(key)), key).toBe(false);
    // Only the safe web link and the (now inert) form widget are left on page 1.
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray().map((a) => doc.context.lookup(a, PDFDict));
    expect(annots.map((a) => a.get(PDFName.of('Subtype'))!.toString()).sort()).toEqual(['/Link', '/Widget']);
    for (const a of annots) for (const k of ['A', 'AA', 'Parent', 'P']) {
      if (k === 'A' && a.get(PDFName.of('Subtype'))!.toString() === '/Link') continue;
      expect(a.has(PDFName.of(k)), k).toBe(false);
    }

    // Text is still there.
    const text = await pageText(out);
    expect(text[0]).toContain('Quarterly report page one');
    expect(text[1]).toContain('Second page text');
    expect(out.toString('latin1')).not.toMatch(/payload\.exe|calc\.exe|app\.alert/);
  });

  const fixtures: [string, Buffer, string[]][] = [
    ['JavaScript OpenAction', B.pdf({ catalogExtra: '/OpenAction<</S/JavaScript/JS(app.alert(1))>>' }), ['JavaScript', 'OpenAction']],
    ['embedded file', B.pdf({ catalogExtra: '/Names<</EmbeddedFiles<</Names[(a) 4 0 R]>>>>', extra: ['<</Type/Filespec/F(a.exe)/EF<</F 5 0 R>>>>'] }), ['EmbeddedFiles']],
    ['Launch', B.pdf({ catalogExtra: '/OpenAction<</S/Launch/F(cmd.exe)>>' }), ['Launch action', 'OpenAction']],
    ['XFA', B.pdf({ catalogExtra: '/AcroForm<</Fields[]/XFA(x)>>' }), ['Form fields (AcroForm)', 'XFA form']],
    ['FileAttachment annotation', B.pdf({ pageExtra: '/Annots[<</Type/Annot/Subtype/FileAttachment/Rect[0 0 1 1]/FS<</Type/Filespec/F(a.exe)>>>>]' }), ['FileAttachment annotation']],
    // An internal GoTo link is kept, but its /Next chain runs JavaScript: only the scrub removes it.
    ['GoTo link with a JavaScript /Next chain', B.pdf({ pageExtra: '/Annots[<</Subtype/Link/Rect[0 0 1 1]/A<</S/GoTo/D[3 0 R/Fit]/Next<</S/JavaScript/JS(app.alert(1))>>>>>>]' }), ['JavaScript']],
    ['GoToR + SubmitForm', B.pdf({ pageExtra: '/Annots[<</Subtype/Link/Rect[0 0 1 1]/A<</S/GoToR/F(x.pdf)/D[0/Fit]>>>><</Subtype/Link/Rect[0 0 1 1]/A<</S/SubmitForm/F(https://e.x/)>>>>]' }), ['Links to other files (GoToR/GoToE)', 'SubmitForm action']],
  ];
  for (const [name, input, removed] of fixtures) {
    it(`sanitizes: ${name}`, async () => {
      const r = await checkUpload(input, 'a.pdf');
      expect(r.sanitized!.removed).toEqual(removed);
      await strictPdfCheck(r.sanitized!.data);
      expect(await assertRebuilt(r.sanitized!.data)).toBe(1);
    });
  }

  it('a clean PDF is rebuilt too (the stored file is always one we wrote), with nothing reported', async () => {
    const r = await checkUpload(B.pdf(), 'a.pdf');
    expect(r.sanitized!.removed).toEqual([]);
    expect(r.sanitized!.data.equals(B.pdf())).toBe(false);
    expect((await PDFDocument.load(r.sanitized!.data, { updateMetadata: false })).getProducer()).toBe('TrustVault PDF sanitizer (pdf-lib)');
  });

  it('fails closed when the rebuilt file does not pass the strict check (re-inspection guard)', async () => {
    // Page content that literally carries "/JavaScript": the page is copied
    // as it is, so the output still trips the raw-byte pass and is refused.
    const p = B.pdf({ pageExtra: '/Contents 4 0 R', extra: [B.streamObj(4, '', Buffer.from('BT /F1 12 Tf (/JavaScript) Tj ET'))] });
    const err = await checkUpload(p, 'a.pdf').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RejectedFile);
    expect((err as RejectedFile).code).toBe('sanitize_failed');
    expect((err as Error).message).toMatch(/^The PDF could not be made safe and was not accepted/);
  });

  it('structural problems are still refused, never sanitized', async () => {
    const cases: [string, Buffer, string][] = [
      ['malformed', Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog/Pages 2 0 R\nendobj\n%%EOF\n', 'latin1'), 'The PDF is damaged or malformed and cannot be checked'],
      ['encrypted', B.pdf({ trailerExtra: '/Encrypt<</Filter/Standard/V 2/R 3/O(x)/U(y)/P -4>>' }), 'Encrypted PDFs cannot be checked; remove the password and upload again'],
      ['PDF + ZIP polyglot', B.pdf({ extra: [B.streamObj(4, '', B.zip([{ name: 'x.txt', data: 'x' }]))] }), 'Files that are also ZIP archives (polyglots) are not accepted'],
      ['data after %%EOF', B.pdf({ trailing: '<html><script>alert(1)</script></html>' }), 'The PDF is truncated or has data appended after its end'],
      ['hidden object', B.pdf({ extra: [B.streamObj(4, '', Buffer.from('9 0 obj <</S/URI/URI(file:///etc/passwd)>> endobj', 'latin1'))] }), 'The PDF has objects hidden inside other objects and cannot be checked'],
    ];
    for (const [name, buf, msg] of cases) {
      const err = await checkUpload(buf, 'a.pdf').then(() => null, (e: unknown) => e);
      expect(err, name).toBeInstanceOf(RejectedFile);
      expect((err as Error).message, name).toBe(msg);
      expect((err as RejectedFile).code, name).toBe('content_rejected');
    }
  });
});
