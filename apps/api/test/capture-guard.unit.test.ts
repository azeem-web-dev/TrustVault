import { describe, expect, it } from 'vitest';

// The web viewer's screen-capture detection (apps/web/src/lib/capture-guard.ts),
// loaded by path: the web app is a separate TypeScript project with no test
// runner of its own. THREATS.md V11.
type Key = { type: string; key: string; code?: string; metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean };
const GUARD: string = new URL('../../web/src/lib/capture-guard.ts', import.meta.url).href;
const g = (await import(GUARD)) as {
  captureMethod: (e: Required<Omit<Key, 'code' | 'altKey'>> & Pick<Key, 'code' | 'altKey'>, platform: string) => string | null;
  shouldReport: (last: Map<string, number>, doc: string, now: number, interval?: number) => boolean;
  REPORT_INTERVAL_MS: number;
};

const ev = (k: Key) => ({ metaKey: false, shiftKey: false, ctrlKey: false, altKey: false, ...k });
const WIN = 'Win32';
const MAC = 'MacIntel';

describe('captureMethod()', () => {
  it('Print Screen on keydown or keyup (Windows often sends only keyup)', () => {
    expect(g.captureMethod(ev({ type: 'keyup', key: 'PrintScreen', code: 'PrintScreen' }), WIN)).toBe('printscreen');
    expect(g.captureMethod(ev({ type: 'keydown', key: 'PrintScreen' }), WIN)).toBe('printscreen');
    expect(g.captureMethod(ev({ type: 'keyup', key: 'Unidentified', code: 'PrintScreen' }), WIN)).toBe('printscreen');
  });

  it('Win+Shift held is the snipping shortcut on Windows, whichever key came second', () => {
    expect(g.captureMethod(ev({ type: 'keydown', key: 'Shift', metaKey: true, shiftKey: true }), WIN)).toBe('snip_shortcut');
    expect(g.captureMethod(ev({ type: 'keydown', key: 'Meta', metaKey: true, shiftKey: true }), WIN)).toBe('snip_shortcut');
    expect(g.captureMethod(ev({ type: 'keydown', key: 'S', code: 'KeyS', metaKey: true, shiftKey: true }), WIN)).toBe('snip_shortcut');
  });

  it('Cmd+Shift and Cmd+Shift+3/4/5 on a Mac (the shifted digit arrives as # $ %)', () => {
    expect(g.captureMethod(ev({ type: 'keydown', key: 'Shift', metaKey: true, shiftKey: true }), MAC)).toBe('mac_shortcut');
    for (const [key, code] of [['#', 'Digit3'], ['$', 'Digit4'], ['%', 'Digit5'], ['4', undefined]] as const) {
      expect(g.captureMethod(ev({ type: 'keydown', key, code, metaKey: true, shiftKey: true }), MAC)).toBe('mac_shortcut');
    }
  });

  it('Ctrl+P and Cmd+P count as attempts', () => {
    expect(g.captureMethod(ev({ type: 'keydown', key: 'p', code: 'KeyP', ctrlKey: true }), WIN)).toBe('print_shortcut');
    expect(g.captureMethod(ev({ type: 'keydown', key: 'p', code: 'KeyP', metaKey: true }), MAC)).toBe('print_shortcut');
  });

  it('ordinary keys and shortcuts are not attempts', () => {
    for (const k of [
      ev({ type: 'keydown', key: 'p' }),
      ev({ type: 'keydown', key: 'c', ctrlKey: true }),
      ev({ type: 'keydown', key: 's', ctrlKey: true }),
      ev({ type: 'keydown', key: 'Shift', shiftKey: true }),
      ev({ type: 'keydown', key: 'Meta', metaKey: true }),
      ev({ type: 'keydown', key: 'ArrowRight' }),
      ev({ type: 'keyup', key: 'Shift', metaKey: true, shiftKey: true }),
      ev({ type: 'keypress', key: 'PrintScreen' }),
    ]) expect(g.captureMethod(k, WIN), JSON.stringify(k)).toBeNull();
  });
});

describe('shouldReport()', () => {
  it('at most one report per document per 10 seconds; documents are independent', () => {
    const last = new Map<string, number>();
    expect(g.REPORT_INTERVAL_MS).toBe(10_000);
    expect(g.shouldReport(last, 'a', 1_000)).toBe(true);
    expect(g.shouldReport(last, 'a', 5_000)).toBe(false);
    expect(g.shouldReport(last, 'b', 5_000)).toBe(true);
    expect(g.shouldReport(last, 'a', 10_999)).toBe(false);
    expect(g.shouldReport(last, 'a', 11_000)).toBe(true);
  });
});
