// Screen-capture deterrence for the view-only page viewer (THREATS.md V11).
//
// The honest limit: a web page cannot stop an operating-system screenshot
// (Print Screen, Snipping Tool, macOS Cmd+Shift+3/4/5), a screen recorder or
// a phone camera. What it can see is some of the key presses that usually
// start one. On those the viewer blanks the pages for a moment, overwrites
// the clipboard and quietly tells the API, which records it for the owner.
// Pure functions only, so they can be tested without a browser.

export type CaptureMethod = 'printscreen' | 'snip_shortcut' | 'mac_shortcut' | 'print_shortcut';

/** What the History tab and the owner's email call each method. */
export const CAPTURE_METHOD_LABEL: Record<CaptureMethod, string> = {
  printscreen: 'Print Screen',
  snip_shortcut: 'Windows snipping shortcut',
  mac_shortcut: 'macOS screenshot shortcut',
  print_shortcut: 'print shortcut',
};

/** Text put on the clipboard after a detected capture (best effort). */
export const CLIPBOARD_NOTICE = 'Screen capture of this document is not allowed.';

/** How long the pages stay blank after a detected capture. */
export const CAPTURE_VEIL_MS = 2000;

/** At most one report per document per this long (per page load). */
export const REPORT_INTERVAL_MS = 10_000;

/** The parts of a KeyboardEvent this module reads. */
export interface KeyLike {
  type: string;
  key: string;
  code?: string;
  metaKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
}

export const isMacPlatform = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);

const SHOT_DIGITS = new Set(['Digit3', 'Digit4', 'Digit5']);

/**
 * Is this key event the likely start of a screen capture, and which kind?
 *
 * - Print Screen, on keydown or keyup (Windows often delivers only keyup).
 * - Meta+Shift held together: Win+Shift+S opens the Snipping Tool; on a Mac
 *   Cmd+Shift+3/4/5 take screenshots. The OS usually swallows the last key,
 *   so the moment Meta and Shift are both down is what the page can see.
 * - Ctrl+P / Cmd+P (printing is already blocked; it still counts).
 */
export function captureMethod(e: KeyLike, platform: string): CaptureMethod | null {
  if (e.type !== 'keydown' && e.type !== 'keyup') return null;
  if (e.key === 'PrintScreen' || e.code === 'PrintScreen') return 'printscreen';
  if (e.type !== 'keydown') return null;
  const mac = isMacPlatform(platform);
  if (e.metaKey && e.shiftKey) {
    // Meta then Shift (or Shift then Meta) is the start of the shortcut.
    if (e.key === 'Shift' || e.key === 'Meta' || e.key === 'OS') return mac ? 'mac_shortcut' : 'snip_shortcut';
    if (e.code && SHOT_DIGITS.has(e.code)) return 'mac_shortcut';
    if (['3', '4', '5', '#', '$', '%'].includes(e.key)) return 'mac_shortcut';
    if (e.code === 'KeyS' || e.key === 's' || e.key === 'S') return mac ? 'mac_shortcut' : 'snip_shortcut';
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) return 'print_shortcut';
  return null;
}

/**
 * Debounce for reports: true (and remembers `now`) when this document has
 * not been reported within `interval` ms; false otherwise.
 */
export function shouldReport(last: Map<string, number>, documentId: string, now: number, interval = REPORT_INTERVAL_MS): boolean {
  const prev = last.get(documentId);
  if (prev !== undefined && now - prev < interval) return false;
  last.set(documentId, now);
  return true;
}
