/**
 * Time windows for access policies (THREATS.md P1-P3).
 *
 * A window is: ISO days of the week (1 Monday .. 7 Sunday) of the LOCAL
 * date, and local minutes since midnight, start inclusive and end exclusive
 * (1440 = end of the day), in a named IANA time zone. The database applies
 * the same rule with AT TIME ZONE (tv_in_window); test/fixtures/window-cases
 * holds the boundary and daylight-saving cases both are tested against.
 */

export interface AccessWindow {
  days: number[];
  start: number;
  end: number;
  tz: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

/** Local ISO weekday and minute-of-day of `at` in `tz`. */
export function localDayMinute(tz: string, at: Date): { day: number; minute: number } {
  const parts = formatter(tz).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return { day: WEEKDAY[get('weekday')] ?? 0, minute: hour * 60 + Number(get('minute')) };
}

/** Null window: always open. */
export function inWindow(w: AccessWindow | null | undefined, at: Date): boolean {
  if (!w) return true;
  const { day, minute } = localDayMinute(w.tz, at);
  return w.days.includes(day) && minute >= w.start && minute < w.end;
}

/** A named IANA zone the runtime knows. POSIX strings like "UTC+5" are refused. */
export function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" to minutes; "24:00" allowed as an end. */
export function parseClock(text: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) throw new Error(`"${text}" is not a time (HH:MM)`);
  const h = Number(m[1]), min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) throw new Error(`"${text}" is not a time (HH:MM)`);
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "Mon-Fri 09:00-17:00 Europe/London" style text for messages. */
export function describeWindow(w: AccessWindow): string {
  return `${w.days.map((d) => DAY_NAMES[d]).join(', ')} ${formatClock(w.start)}–${formatClock(w.end)} (${w.tz})`;
}
