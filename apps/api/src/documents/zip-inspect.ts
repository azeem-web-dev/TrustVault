/**
 * Strict ZIP reading and Office Open XML active-content checks.
 *
 * Office files are ZIPs. Different ZIP readers disagree on malformed
 * archives (central directory vs local headers, duplicate names,
 * overlapping entries, data hidden in gaps), and every disagreement is a
 * way to show the checker one file and Office another. So the reader here
 * refuses anything a careful writer would never produce, and only inflates
 * the few small XML parts it must read, each with a hard output cap.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipRejected extends Error {}

export const ZIP_LIMITS = {
  /** Entries in one archive. Big decks have a few thousand. */
  maxEntries: 10_000,
  /** Sum of declared uncompressed sizes. */
  maxTotalUncompressed: 1024 * 1024 * 1024,
  /** Declared ratio above which a large entry is treated as a bomb. */
  maxRatio: 1000,
  /** A part is read in full only up to this size. */
  maxPartBytes: 64 * 1024 * 1024,
  /** All parts read during one check, embedded packages included. */
  maxInflatedTotal: 256 * 1024 * 1024,
  /** Office files inside Office files (chart data), checked recursively. */
  maxDepth: 2,
};

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const bad = (why: string): never => { throw new ZipRejected(why); };

/** Finds the end-of-central-directory record, or -1. */
export function findEocd(buf: Buffer): number {
  const searchFrom = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/**
 * True if the end of `buf` holds a ZIP central directory a ZIP reader would
 * accept. Used to refuse polyglots (a PDF or image that is also a ZIP).
 */
export function looksLikeZip(buf: Buffer): boolean {
  if (buf.length < 22) return false;
  const searchFrom = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const entries = buf.readUInt16LE(i + 10);
    const cdSize = buf.readUInt32LE(i + 12);
    const cdOffset = buf.readUInt32LE(i + 16);
    if (entries === 0) return true; // an empty archive is still an archive
    if (cdOffset + 4 <= buf.length && buf.readUInt32LE(cdOffset) === CEN) return true;
    // Self-extracting style: offsets relative to a prefix. Readers that
    // compensate (most do) find the directory just before the EOCD.
    const rel = i - cdSize;
    if (rel >= 0 && rel + 4 <= buf.length && buf.readUInt32LE(rel) === CEN) return true;
  }
  return false;
}

/** Reads and cross-checks the whole archive structure. Throws ZipRejected. */
export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) bad('truncated archive');
  const eocd = findEocd(buf);
  if (eocd < 0) bad('no end of central directory');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesHere = buf.readUInt16LE(eocd + 8);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) bad('multi-disk archive');
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) bad('ZIP64 archive');
  // Nothing may follow the archive (no appended second file).
  if (eocd + 22 + commentLen !== buf.length) bad('data after the end of the archive');
  if (entries === 0) bad('empty archive');
  if (entries > ZIP_LIMITS.maxEntries) bad('too many entries');
  if (cdOffset + cdSize !== eocd) bad('central directory does not end where the archive says');

  const list: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN) bad('central directory entry malformed');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + cLen > eocd) bad('central directory entry malformed');
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    if (diskStart !== 0) bad('multi-disk archive');
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) bad('ZIP64 entry');
    if (flags & 0x0041) bad('encrypted entry');
    if (method !== 0 && method !== 8) bad('unsupported compression method');
    if (method === 0 && compSize !== size) bad('stored entry sizes disagree');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      bad('entry name is not valid UTF-8');
    }
    name = name!;
    if (name.length === 0 || /[\u0000-\u001f\u007f]/.test(name)) bad('entry name has control characters');
    // Office part names are case-insensitive: two spellings of one name
    // would let the checker read one part and Office the other.
    const key = name.toLowerCase();
    if (seen.has(key)) bad('duplicate entry name');
    seen.add(key);
    total += size;
    if (total > ZIP_LIMITS.maxTotalUncompressed) bad('archive expands to more than the limit');
    if (size > 1024 * 1024 && size / Math.max(compSize, 1) > ZIP_LIMITS.maxRatio) bad('compression ratio too high (zip bomb)');

    // The local header must describe the same entry.
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOC) bad('local header missing');
    const lFlags = buf.readUInt16LE(localOffset + 6);
    const lMethod = buf.readUInt16LE(localOffset + 8);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    if (lMethod !== method || (lFlags & 0x0041) !== (flags & 0x0041) || (lFlags & 0x0008) !== (flags & 0x0008)) bad('local header disagrees with central directory');
    if (!buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).equals(nameBytes)) bad('local header name disagrees with central directory');
    if (!(flags & 0x0008)) {
      if (buf.readUInt32LE(localOffset + 14) !== crc || buf.readUInt32LE(localOffset + 18) !== compSize || buf.readUInt32LE(localOffset + 22) !== size) {
        bad('local header sizes disagree with central directory');
      }
    }
    const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
    if (dataOffset + compSize > cdOffset) bad('entry runs into the central directory');
    list.push({ name, method, flags, crc, compSize, size, localOffset, dataOffset });
    p += 46 + nameLen + extraLen + cLen;
  }
  if (p !== eocd) bad('central directory size mismatch');

  // Entries must tile the space before the central directory: no overlap
  // (overlapping-entry zip bombs), no gaps (hidden content).
  const ordered = [...list].sort((a, b) => a.localOffset - b.localOffset);
  let cursor = 0;
  for (const e of ordered) {
    if (e.localOffset !== cursor) bad(e.localOffset < cursor ? 'overlapping entries' : 'unaccounted data between entries');
    cursor = e.dataOffset + e.compSize;
    if (e.flags & 0x0008) cursor += descriptorLength(buf, cursor, e);
  }
  if (cursor !== cdOffset) bad('unaccounted data before the central directory');
  return list;
}

function descriptorLength(buf: Buffer, at: number, e: ZipEntry): number {
  const hasSig = at + 4 <= buf.length && buf.readUInt32LE(at) === DESCRIPTOR;
  const base = hasSig ? at + 4 : at;
  if (base + 12 > buf.length) bad('data descriptor missing');
  if (buf.readUInt32LE(base) !== e.crc || buf.readUInt32LE(base + 4) !== e.compSize || buf.readUInt32LE(base + 8) !== e.size) {
    bad('data descriptor disagrees with central directory');
  }
  return (hasSig ? 4 : 0) + 12;
}

/** A reader over one archive with a shared inflate budget. */
class Package {
  readonly entries: ZipEntry[];
  readonly byName: Map<string, ZipEntry>;
  constructor(private readonly buf: Buffer, private readonly budget: { left: number }) {
    this.entries = readZip(buf);
    this.byName = new Map(this.entries.map((e) => [e.name.toLowerCase(), e]));
  }

  read(e: ZipEntry): Buffer {
    if (e.size > ZIP_LIMITS.maxPartBytes) bad(`part ${e.name} is too large to check`);
    if (e.size > this.budget.left) bad('archive expands to more than the limit');
    const raw = this.buf.subarray(e.dataOffset, e.dataOffset + e.compSize);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else {
      try {
        // Cap at the declared size: a lying header cannot make us inflate more.
        out = inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
      } catch {
        bad(`part ${e.name} is corrupt or larger than declared`);
      }
    }
    out = out!;
    if (out.length !== e.size) bad(`part ${e.name} size disagrees with the directory`);
    if (crc32(out) >>> 0 !== e.crc) bad(`part ${e.name} checksum mismatch`);
    this.budget.left -= out.length;
    return out;
  }

  text(e: ZipEntry): string {
    const b = this.read(e);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
    return b.toString('utf8').replace(/^﻿/, '');
  }
}

/** Decodes the five XML entities and numeric character references. */
export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, ent: string) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1]!.includes(':') ? m[1]!.split(':').pop()! : m[1]!;
    out[name] = xmlDecode(m[2] ?? m[3] ?? '');
  }
  return out;
}

const XML_PART = /\.(xml|rels|vml)$/i;
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData|ms-office\.activeX|\.ms-excel\.(intl)?macrosheet/i;
const ALLOWED_EXTERNAL = /\/hyperlink$/i;
const SAFE_LINK = /^(https?:\/\/|mailto:|#)/i;
const EMBEDDED_OFFICE = /\.(docx|xlsx|pptx)$/i;

export type OoxmlKind = 'docx' | 'xlsx' | 'pptx';

/**
 * Checks an Office Open XML package. Refuses macros, ActiveX, OLE objects,
 * external relationships other than ordinary web/mail hyperlinks (remote
 * templates, external workbook links, linked images), DDE fields and DDE
 * formulas. Returns the kind of document.
 */
export function inspectOoxml(buf: Buffer, depth = 0, budget = { left: ZIP_LIMITS.maxInflatedTotal }): OoxmlKind {
  if (depth > ZIP_LIMITS.maxDepth) bad('Office files nested too deeply');
  const pkg = new Package(buf, budget);
  const names = pkg.entries.map((e) => e.name);

  if (names.some((n) => n.includes('..') || n.startsWith('/') || n.includes('\\') || /^[a-z]:/i.test(n))) {
    throw new ZipRejected('The archive contains unsafe paths');
  }
  if (names.some((n) => /(^|\/)vbaProject(Signature)?\.bin$/i.test(n) || /(^|\/)vbaData\.xml$/i.test(n))) {
    throw new ZipRejected('Macro-enabled Office files are not accepted');
  }
  if (names.some((n) => /^xl\/macrosheets\//i.test(n))) throw new ZipRejected('Excel 4.0 macro sheets are not accepted');
  if (names.some((n) => /(^|\/)activeX\//i.test(n))) throw new ZipRejected('Office files with ActiveX controls are not accepted');
  if (names.some((n) => /^xl\/externalLinks\//i.test(n))) throw new ZipRejected('Workbooks linked to external files are not accepted');

  const ct = pkg.byName.get('[content_types].xml');
  if (!ct) bad('not an Office document');

  // Every XML part: no DTDs (entities could hide content from these checks).
  const xmlParts = pkg.entries.filter((e) => XML_PART.test(e.name));
  const texts = new Map<string, string>();
  for (const e of xmlParts) {
    const t = pkg.text(e);
    if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new ZipRejected('Office files with XML document type declarations are not accepted');
    texts.set(e.name, t);
  }

  if (MACRO_TYPE.test(texts.get(ct!.name) ?? '')) throw new ZipRejected('Macro-enabled Office files are not accepted');

  for (const [name, xml] of texts) {
    if (/\.rels$/i.test(name)) checkRelationships(xml);
  }

  // OLE objects and anything else embedded. Embedded Office packages (the
  // data behind a chart) are checked like the outer file.
  for (const e of pkg.entries) {
    if (!/(^|\/)embeddings\//i.test(e.name) || e.name.endsWith('/')) continue;
    if (!EMBEDDED_OFFICE.test(e.name)) throw new ZipRejected('Office files with embedded OLE objects are not accepted');
    const inner = pkg.read(e);
    if (inner.length < 4 || inner.readUInt32LE(0) !== LOC) throw new ZipRejected('Office files with embedded OLE objects are not accepted');
    inspectOoxml(inner, depth + 1, budget);
  }

  // DDE fields in Word; DDE formulas in Excel.
  for (const [name, xml] of texts) {
    if (/^word\/.*\.xml$/i.test(name)) checkWordFields(xml);
    if (/^xl\/worksheets\/.*\.xml$/i.test(name)) checkFormulas(xml);
  }

  if (names.some((n) => /^word\//i.test(n))) return 'docx';
  if (names.some((n) => /^xl\//i.test(n))) return 'xlsx';
  if (names.some((n) => /^ppt\//i.test(n))) return 'pptx';
  return bad('not an Office document');
}

function checkRelationships(xml: string): void {
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
    const a = attrs(m[1]!);
    const type = a.Type ?? '';
    if (/\/oleObject$/i.test(type)) throw new ZipRejected('Office files with embedded OLE objects are not accepted');
    if (/\/(activeXControl|activeXControlBinary)$/i.test(type)) throw new ZipRejected('Office files with ActiveX controls are not accepted');
    if (/vbaProject/i.test(type)) throw new ZipRejected('Macro-enabled Office files are not accepted');
    if ((a.TargetMode ?? '').toLowerCase() === 'external') {
      if (!ALLOWED_EXTERNAL.test(type)) {
        throw new ZipRejected('Office files that load external content (remote templates, linked files or images) are not accepted');
      }
      if (!SAFE_LINK.test((a.Target ?? '').trim())) {
        throw new ZipRejected('Office files with links to local files or network shares are not accepted');
      }
    }
  }
}

/** Field codes can be split across runs ("DD" + "EAUTO"), so join them first. */
function checkWordFields(xml: string): void {
  const parts: string[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?instrText\b[^>]*>([^<]*)</g)) parts.push(xmlDecode(m[1]!));
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?fldSimple\b([^>]*)>/g)) parts.push(' ' + (attrs(m[1]!).instr ?? '') + ' ');
  const joined = parts.join('');
  const compact = joined.replace(/\s+/g, ' ');
  if (/\bDDE(AUTO)?\b/i.test(compact) || /\bDDE(AUTO)?\b/i.test(joined.replace(/\s+/g, ''))) {
    throw new ZipRejected('Word documents with DDE fields are not accepted');
  }
  if (/\b(INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK)\b[^]*?("|\s)(\\\\|\/\/|[a-z][a-z0-9+.-]*:)/i.test(compact)) {
    throw new ZipRejected('Word documents with fields that load external files are not accepted');
  }
}

function checkFormulas(xml: string): void {
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?f\b[^>]*>([^<]*)</g)) {
    const f = xmlDecode(m[1]!);
    // DDE: application|topic!item, e.g. cmd|'/c calc'!A1
    if (/[A-Za-z0-9_.$-]+\s*\|\s*['"]?[^!]*['"]?\s*!/.test(f)) throw new ZipRejected('Workbooks with DDE formulas are not accepted');
  }
}
