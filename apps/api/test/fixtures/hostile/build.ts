/**
 * Builders for the adversarial upload corpus (THREATS.md C1-C8).
 *
 * Every hostile file is generated here from readable source, not stored as
 * an opaque binary: a reviewer can see exactly what each case contains, and
 * the corpus cannot itself become a way to smuggle something into the repo.
 */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

// ------------------------------------------------------------------ PDF

export interface PdfOptions {
  /** Extra text after %%EOF. */
  trailing?: string;
  /** Extra trailer entries, e.g. '/Encrypt 9 0 R'. */
  trailerExtra?: string;
  /** Leave out the xref table and trailer (some writers do; pdf-lib copes). */
  noXref?: boolean;
  /** Bytes inserted before %PDF- (still a PDF to readers that search the first 1 KB). */
  prefix?: string;
}

/**
 * A PDF from object bodies. Object 1 is the catalog, 2 the page tree, 3 a
 * page; `extra` bodies become objects 4, 5, ... `catalogExtra` and
 * `pageExtra` are spliced into those dictionaries. A body may also be a
 * Buffer (already a complete "N 0 obj ... endobj" chunk, e.g. a stream).
 */
export function pdf(opts: { catalogExtra?: string; pageExtra?: string; extra?: (string | Buffer)[] } & PdfOptions = {}): Buffer {
  const bodies: (string | Buffer)[] = [
    `<</Type/Catalog/Pages 2 0 R${opts.catalogExtra ?? ''}>>`,
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]${opts.pageExtra ?? ''}>>`,
    ...(opts.extra ?? []),
  ];
  const chunks: Buffer[] = [Buffer.from(`${opts.prefix ?? ''}%PDF-1.7\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  const offsets: number[] = [];
  let len = chunks[0]!.length;
  bodies.forEach((b, i) => {
    offsets.push(len);
    const chunk = Buffer.isBuffer(b) ? b : Buffer.from(`${i + 1} 0 obj\n${b}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    len += chunk.length;
  });
  if (!opts.noXref) {
    const xref = [`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<</Size ${bodies.length + 1}/Root 1 0 R${opts.trailerExtra ?? ''}>>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  } else {
    chunks.push(Buffer.from(`trailer\n<</Root 1 0 R${opts.trailerExtra ?? ''}>>\n%%EOF\n`, 'latin1'));
  }
  if (opts.trailing) chunks.push(Buffer.from(opts.trailing, 'latin1'));
  return Buffer.concat(chunks);
}

/** A stream object "num 0 obj <<dict /Length n>> stream ... endstream endobj". */
export function streamObj(num: number, dict: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${num} 0 obj\n<<${dict}/Length ${data.length}>>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

/**
 * A Flate-compressed object stream holding the given objects. The raw file
 * then shows only compressed bytes: no /JavaScript for a regex to find.
 */
export function objStm(num: number, objects: { num: number; body: string }[], filter = 'FlateDecode'): Buffer {
  let header = '';
  let body = '';
  for (const o of objects) {
    header += `${o.num} ${body.length} `;
    body += `${o.body}\n`;
  }
  const raw = Buffer.from(header + body, 'latin1');
  const data = filter === 'FlateDecode' ? deflateSync(raw) : raw;
  return streamObj(num, `/Type/ObjStm/N ${objects.length}/First ${header.length}${filter ? `/Filter/${filter}` : ''}`, data);
}

/** A Flate stream that inflates to `size` zero bytes (stream "zip bomb"). */
export function bombObjStm(num: number, size: number): Buffer {
  const data = deflateSync(Buffer.alloc(size), { level: 9 });
  return streamObj(num, `/Type/ObjStm/N 1/First 4/Filter/FlateDecode`, data);
}

// ------------------------------------------------------------------ ZIP

export interface ZipFile {
  name: string;
  data: Buffer | string;
  /** Store instead of deflate. */
  store?: boolean;
}

export interface ZipTricks {
  /** Name in the local header differs from the central directory. */
  localName?: Record<string, string>;
  /** Write sizes as 0 in the local header and append data descriptors. */
  descriptors?: boolean;
  /** Bytes inserted after this entry's data (a gap). */
  gapAfter?: Record<string, Buffer>;
  /** Point this entry's central record at another entry's local header (overlap). */
  pointAt?: Record<string, string>;
  /** Override the compressed size in both headers (entries then overlap). */
  declaredComp?: Record<string, number>;
  /** Override declared uncompressed sizes in both headers. */
  declaredSize?: Record<string, number>;
  /** Bytes after the end-of-central-directory record. */
  trailing?: Buffer;
  /** Bytes before the first local header. */
  prefix?: Buffer;
  /** Override the entry count in the EOCD. */
  eocdEntries?: number;
  /** Set the general purpose flags (e.g. 1 = encrypted). */
  flags?: Record<string, number>;
}

export function zip(files: ZipFile[], tricks: ZipTricks = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const localOffsets: number[] = [];
  const firstOffset = new Map<string, number>();
  let offset = tricks.prefix?.length ?? 0;
  if (tricks.prefix) locals.push(tricks.prefix);
  const pending: { f: ZipFile; name: Buffer; method: number; crc: number; compLen: number; size: number; flags: number }[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const method = f.store ? 0 : 8;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name, 'utf8');
    const size = tricks.declaredSize?.[f.name] ?? data.length;
    const flags = (tricks.flags?.[f.name] ?? 0) | (tricks.descriptors ? 0x0008 : 0) | 0x0800;
    const crc = crc32(data) >>> 0;
    const lname = Buffer.from(tricks.localName?.[f.name] ?? f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(tricks.descriptors ? 0 : crc, 14);
    const compLen = tricks.declaredComp?.[f.name] ?? comp.length;
    local.writeUInt32LE(tricks.descriptors ? 0 : compLen, 18);
    local.writeUInt32LE(tricks.descriptors ? 0 : size, 22);
    local.writeUInt16LE(lname.length, 26);
    localOffsets.push(offset);
    if (!firstOffset.has(f.name)) firstOffset.set(f.name, offset);
    locals.push(local, lname, comp);
    offset += 30 + lname.length + comp.length;
    if (tricks.descriptors) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(comp.length, 8);
      d.writeUInt32LE(size, 12);
      locals.push(d);
      offset += 16;
    }
    const gap = tricks.gapAfter?.[f.name];
    if (gap) { locals.push(gap); offset += gap.length; }
    pending.push({ f, name, method, crc, compLen, size, flags });
  }
  for (const [i, p] of pending.entries()) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(p.flags, 8);
    central.writeUInt16LE(p.method, 10);
    central.writeUInt32LE(p.crc, 16);
    central.writeUInt32LE(p.compLen, 20);
    central.writeUInt32LE(p.size, 24);
    central.writeUInt16LE(p.name.length, 28);
    const target = tricks.pointAt?.[p.f.name];
    central.writeUInt32LE(target ? firstOffset.get(target)! : localOffsets[i]!, 42);
    centrals.push(central, p.name);
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(tricks.eocdEntries ?? files.length, 8);
  eocd.writeUInt16LE(tricks.eocdEntries ?? files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd, tricks.trailing ?? Buffer.alloc(0)]);
}

// --------------------------------------------------------------- OOXML

const CT_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (items: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** A minimal, valid Word document. `body` is WordprocessingML inside <w:body>. */
export function docx(opts: { body?: string; docRels?: string; extra?: ZipFile[]; contentTypes?: string } = {}, tricks?: ZipTricks): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: `${CT_HEAD}<Override PartName="/word/document.xml" ContentType="${opts.contentTypes ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'}"/></Types>` },
    { name: '_rels/.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`) },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W_NS}" xmlns:r="${REL}"><w:body>${opts.body ?? '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>'}</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: rels(opts.docRels ?? '') },
    ...(opts.extra ?? []),
  ], tricks);
}

/** A minimal, valid Excel workbook. `sheet` is the <sheetData> content. */
export function xlsx(opts: { sheet?: string; wbRels?: string; extra?: ZipFile[] } = {}): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: `${CT_HEAD}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`) },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>${opts.wbRels ?? ''}`) },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${opts.sheet ?? '<row r="1"><c r="A1"><v>1</v></c></row>'}</sheetData></worksheet>` },
    ...(opts.extra ?? []),
  ]);
}

/** A minimal PowerPoint package. */
export function pptx(opts: { extra?: ZipFile[]; slideRels?: string } = {}): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: `${CT_HEAD}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>` },
    { name: '_rels/.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`) },
    { name: 'ppt/presentation.xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: rels(opts.slideRels ?? '') },
    ...(opts.extra ?? []),
  ]);
}

export const relationship = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;

// ---------------------------------------------------------------- images

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/**
 * A valid 1x1 PNG, optionally with extra chunks (e.g. tEXt) before IEND.
 * `dims` overrides the IHDR width/height (the structural check never decodes
 * IDAT, so the declared size alone drives the pixel-cap test).
 */
export function png(extraChunks: [string, Buffer][] = [], dims?: { width: number; height: number }): Buffer {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  if (dims) { ihdr.writeUInt32BE(dims.width, 0); ihdr.writeUInt32BE(dims.height, 4); }
  const idat = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extraChunks.map(([t, d]) => pngChunk(t, d)),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A structurally valid baseline JPEG (markers and lengths; the pixels do not matter). */
export function jpeg(opts: { comment?: string; width?: number; height?: number } = {}): Buffer {
  const seg = (marker: number, data: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt8(0xff, 0);
    h.writeUInt8(marker, 1);
    h.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([h, data]);
  };
  const h = opts.height ?? 1;
  const w = opts.width ?? 1;
  const sof = Buffer.from([8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(opts.comment ? [seg(0xfe, Buffer.from(opts.comment, 'latin1'))] : []),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, sof),
    seg(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]), // entropy data with a stuffed byte and a restart marker
    Buffer.from([0xff, 0xd9]),
  ]);
}
