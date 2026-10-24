/**
 * Gestation calculations, mirroring backend/app/gestation.py (Req 4.1–4.3).
 *
 * Dates are "YYYY-MM-DD" strings. Arithmetic uses UTC fields only, so results do
 * not depend on the browser's time zone or DST.
 *
 * - GA is the number of days from LMP to a date.
 * - EDD follows Naegele's rule: LMP + 7 days, then + 9 calendar months with the day
 *   clamped to the target month's last day.
 * - Trimester: 1 below 98 days, 2 for 98–195, 3 from 196.
 */
import { addDays, daysBetween, formatIsoDate, parseIsoDate, utcDateMs } from './time';

/** Python-style floor division and modulo, so negative GA matches the backend. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Gestational age in days at `on`. */
export function gaDays(lmp: string, on: string): number {
  return daysBetween(lmp, on);
}

/** Display form `{weeks}w {days}d` (Python `days // 7`, `days % 7`). */
export function gaLabel(days: number): string {
  return `${floorDiv(days, 7)}w ${pyMod(days, 7)}d`;
}

function daysInMonth(year: number, month1: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(utcDateMs(year, month1, 0)).getUTCDate();
}

/** Add calendar months, clamping the day to the target month's last day. */
export function addMonthsClamped(date: string, months: number): string {
  const ms = parseIsoDate(date);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid date: ${date}`);
  const d = new Date(ms);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = floorDiv(total, 12);
  const month1 = pyMod(total, 12) + 1;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month1));
  return formatIsoDate(utcDateMs(year, month1 - 1, day));
}

/** Estimated delivery date by Naegele's rule. */
export function eddNaegele(lmp: string): string {
  return addMonthsClamped(addDays(lmp, 7), 9);
}

/** 1 below 98 days, 2 for 98–195, 3 from 196. */
export function trimester(ga: number): 1 | 2 | 3 {
  if (ga < 98) return 1;
  if (ga < 196) return 2;
  return 3;
}
