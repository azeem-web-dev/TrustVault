// Local-time helpers (X6). Date inputs give 'YYYY-MM-DD' and datetime-local
// inputs give 'YYYY-MM-DDTHH:mm' with no offset. `new Date('2026-01-31')`
// parses as UTC midnight, which shifts the day for anyone not on UTC, so
// these build the Date from its parts in the browser's time zone and only
// then convert to an ISO instant for the API.

const pad = (n: number) => String(n).padStart(2, '0');

function parseDay(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Start of the given local day (00:00:00.000) as an ISO instant, or undefined if empty/invalid. */
export function localDayStartISO(v: string | Date | null | undefined): string | undefined {
  const d = parseDay(v);
  return d ? d.toISOString() : undefined;
}

/** End of the given local day (23:59:59.999) as an ISO instant, or undefined if empty/invalid. */
export function localDayEndISO(v: string | Date | null | undefined): string | undefined {
  const d = parseDay(v);
  if (!d) return undefined;
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** Today's local date as 'YYYY-MM-DD', for a date input's `min`/`max`/default. */
export function localTodayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toLocalDateInput(d);
}

/** A datetime-local value ('YYYY-MM-DDTHH:mm[:ss]') read in local time, as an ISO instant. */
export function localInputToISO(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v.trim());
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** An ISO instant (or Date) as a local 'YYYY-MM-DD' for a date input. Empty string if missing. */
export function toLocalDateInput(v: string | Date | null | undefined): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An ISO instant (or Date) as a local 'YYYY-MM-DDTHH:mm' for a datetime-local input. Empty string if missing. */
export function toLocalDateTimeInput(v: string | Date | null | undefined): string {
  const day = toLocalDateInput(v);
  if (!day) return '';
  const d = v instanceof Date ? v : new Date(v as string);
  return `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
