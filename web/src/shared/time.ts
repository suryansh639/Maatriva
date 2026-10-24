/**
 * Time helpers mirroring backend/app/timeutil.py.
 *
 * IST is a fixed UTC+05:30 offset (no DST), so "the IST date" of an instant is the
 * UTC calendar date of that instant shifted by +5h30m. All arithmetic here is on
 * epoch milliseconds or UTC fields, never on the browser's local time zone.
 */

/** UTC+05:30 in milliseconds (19 800 000). */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "YYYY-MM-DDTHH:MM[:SS[.fraction]]" followed by "Z" or "±hh:mm".
const ISO_DT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A clock returning epoch milliseconds; injectable for tests. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** The IST calendar date ("YYYY-MM-DD") of an instant given as a Date or epoch ms. */
export function istDate(instant: Date | number): string {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's IST calendar date ("YYYY-MM-DD"). Mirrors `timeutil.today_ist()`. */
export function todayIST(clock: Clock = systemClock): string {
  return istDate(clock());
}

/** Current instant as a UTC ISO-8601 string with a "Z" suffix. */
export function nowIsoZ(clock: Clock = systemClock): string {
  return new Date(clock()).toISOString();
}

/** Serialize an instant as UTC ISO-8601 with a "Z" suffix (millisecond precision). */
export function toIsoZ(instant: Date | number): string {
  return new Date(typeof instant === 'number' ? instant : instant.getTime()).toISOString();
}

/**
 * Parse a backend datetime ("…Z" or "…±hh:mm", any fraction length) to epoch ms.
 * Fractions beyond milliseconds (Python emits microseconds) are truncated, so the
 * result does not depend on how the JS engine handles long fractions.
 * Returns NaN for strings that are not ISO-8601 datetimes with a zone.
 */
export function parseIsoZ(value: string): number {
  const m = ISO_DT_RE.exec(value);
  if (!m) return Number.NaN;
  const fraction = m[2] ? m[2].slice(0, 4).padEnd(4, '0') : '';
  return Date.parse(`${m[1]}${fraction}${m[3]}`);
}

/**
 * UTC midnight epoch ms for a year, 0-based month and day. Unlike `Date.UTC`, years
 * 0–99 are not mapped to 1900–1999. Out-of-range months/days roll over as usual.
 */
export function utcDateMs(year: number, month0: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month0, day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Parse "YYYY-MM-DD" as UTC midnight epoch ms; NaN when not a real calendar date. */
export function parseIsoDate(value: string): number {
  const m = DATE_RE.exec(value);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = utcDateMs(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return Number.NaN;
  }
  return ms;
}

/** True when `value` is a valid "YYYY-MM-DD" calendar date. */
export function isIsoDate(value: string): boolean {
  return !Number.isNaN(parseIsoDate(value));
}

/** Format UTC-midnight epoch ms as "YYYY-MM-DD". */
export function formatIsoDate(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

/** Add whole days to a "YYYY-MM-DD" date. Throws on an invalid date. */
export function addDays(date: string, days: number): string {
  const ms = parseIsoDate(date);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${date}`);
  return formatIsoDate(ms + days * MS_PER_DAY);
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError(`Invalid date: ${from} / ${to}`);
  return Math.round((b - a) / MS_PER_DAY);
}

/** "hh:mm" of an instant in IST (used by the sync badge "Synced {hh:mm}"). */
export function formatIstHHMM(instant: Date | number): string {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
}
