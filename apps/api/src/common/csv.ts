/**
 * CSV formula injection (THREATS.md C7).
 *
 * A spreadsheet opening a CSV treats a cell that starts with = + - @ (or a
 * tab / carriage return that it strips first) as a formula: =HYPERLINK()
 * to exfiltrate, DDE (=cmd|'/c calc'!A1) to run commands on old Excel.
 *
 * Two uses:
 *  - csvCell()/toCsv(): every CSV this app generates goes through them.
 *  - neutralizeCsv(): the "formulas disabled" copy of an uploaded CSV. The
 *    stored file is never changed (its SHA-256 is the integrity anchor in
 *    the audit trail); the safe copy is made on the fly at download.
 */

/** Characters a spreadsheet may treat as the start of a formula (incl. full-width forms). */
const TRIGGER = /^[=+\-@\t\r＝＋－＠]/;
/** Plain numbers stay numbers: "-5" and "+3.2e4" are not formulas. */
const NUMBER = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/;

export const isDangerousCell = (v: string): boolean => TRIGGER.test(v) && !NUMBER.test(v);

const neutral = (v: string): string => (isDangerousCell(v) ? `'${v}` : v);

/** One cell of a CSV this app writes: neutralised, then quoted if needed. */
export function csvCell(value: unknown, delimiter = ','): string {
  const v = neutral(value === null || value === undefined ? '' : String(value));
  return /["\r\n]/.test(v) || v.includes(delimiter) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: unknown[][], delimiter = ','): string {
  return rows.map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

/** Picks the delimiter a spreadsheet would most likely use for this file. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, 64 * 1024).split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let n = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** RFC 4180 parse, tolerant of text after a closing quote. */
export function parseCsv(text: string, delimiter: string): { value: string; quoted: boolean }[][] {
  const rows: { value: string; quoted: boolean }[][] = [];
  const n = text.length;
  if (n === 0) return rows;
  let row: { value: string; quoted: boolean }[] = [];
  let i = 0;
  const stop = (c: string | undefined) => c === delimiter || c === '\n' || c === '\r';
  for (;;) {
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += text[i++];
      }
    }
    while (i < n && !stop(text[i])) value += text[i++];
    row.push({ value, quoted });
    if (i >= n) { rows.push(row); break; }
    if (text[i] === delimiter) { i++; continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}



/**
 * The "formulas disabled" copy of a CSV: every cell a spreadsheet would
 * run as a formula gets a leading apostrophe. Returns the new bytes and
 * how many cells were changed.
 */
export function neutralizeCsv(data: Buffer): { data: Buffer; changed: number } {
  let text = data.toString('utf8');
  const bom = text.startsWith('﻿');
  if (bom) text = text.slice(1);
  const delimiter = sniffDelimiter(text);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const trailingEol = /\r?\n$/.test(text);
  let changed = 0;
  const out = parseCsv(text, delimiter).map((row) => row.map(({ value, quoted }) => {
    const dangerous = isDangerousCell(value);
    if (dangerous) changed++;
    const v = dangerous ? `'${value}` : value;
    const needsQuotes = quoted || /["\r\n]/.test(v) || v.includes(delimiter);
    return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(delimiter)).join(eol);
  return { data: Buffer.from((bom ? '﻿' : '') + out + (trailingEol ? eol : ''), 'utf8'), changed };
}

/** Counts cells a spreadsheet would treat as formulas (for the warning header). */
export function countFormulaCells(data: Buffer): number {
  return neutralizeCsv(data).changed;
}
