/**
 * Client mirror of the sync field validation (Requirement 11, Req 29.7).
 *
 * Same rules as `backend/app/schemas.py` (`MotherIn`, `VisitIn`, `TaskCompleteIn`),
 * so the forms keep Save disabled for anything the server would reject. Both suites
 * check the shared boundary vectors in `validation.vectors.json` (a copy of
 * `backend/tests/fixtures/validation_vectors.json`).
 *
 * Each validator returns either the normalized record (the shape that is pushed) or
 * one i18n message key per failing field, for inline `aria-describedby` errors.
 *
 * Normalization, as on the server:
 * - UUIDs must be canonical 8-4-4-4-12 hex (any case) and come out lowercase.
 * - Names are trimmed, then must be 1–100 characters (code points).
 * - A blank `phone` ("" or whitespace) is treated as absent.
 * - Weights are rounded to 2 dp and Hb to 1 dp (Python `round`), after the range check.
 * - `ble_raw_hex` is lowercased with spaces removed, then checked.
 * - Datetimes need a timezone (`Z` or `±hh:mm`), must be at most 24 h after `now`,
 *   and come out as UTC ISO-8601 with a "Z" suffix.
 * - Unknown keys (server-owned fields) are dropped; absent optional fields become null.
 *
 * JavaScript limit: JSON `24.0` and `24` are the same number here, so a float with a
 * zero fraction passes the integer checks (the server's strict int rejects it).
 *
 * Visit-date rules that need the mother (Req 11.9) run only when `lmpDate` is given;
 * "not later than today + 1" (IST) always runs.
 */

import type { MessageKey } from '../shared/i18n';
import { gaDays } from '../shared/gestation';
import { addDays, istDate, parseIsoDate, systemClock, toIsoZ, todayIST, type Clock } from '../shared/time';
import type { BpSource, HbSource, MotherIn, TaskCompleteIn, VisitIn, WeightSource } from '../shared/types';

// --------------------------------------------------------------------------- limits

export const NAME_MAX = 100;
export const AGE_MIN = 14;
export const AGE_MAX = 55;
export const PHONE_RE = /^[6-9][0-9]{9}$/;
export const GA_AT_REGISTRATION_MAX = 308;
export const HEIGHT_MIN = 120;
export const HEIGHT_MAX = 200;
export const WEIGHT_MIN = 25;
export const WEIGHT_MAX = 150;
export const HB_MIN = 3.0;
export const HB_MAX = 20.0;
export const BP_SYS_MIN = 60;
export const BP_SYS_MAX = 260;
export const BP_DIA_MIN = 30;
export const BP_DIA_MAX = 160;
export const TABLETS_MIN = 0;
export const TABLETS_MAX = 180;
export const NOTES_MAX = 500;
export const DONE_NOTE_MAX = 300;
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
export const BLE_HEX_RE = /^(?:[0-9a-f]{2}){0,40}$/;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
// "YYYY-MM-DD[T ]HH:MM[:SS[.ffffff]]" + "Z" or "±hh[:]mm".
const DATETIME_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]{1,6}))?)?(?:([Zz])|([+-])([0-9]{2}):?([0-9]{2}))$/;

const WEIGHT_SOURCES: readonly WeightSource[] = ['manual', 'ble', 'simulated'];
const HB_SOURCES: readonly HbSource[] = ['manual', 'device'];
const BP_SOURCES: readonly BpSource[] = ['manual', 'ble', 'simulated'];

// --------------------------------------------------------------------------- result types

export type MotherField = keyof MotherIn;
export type VisitField = keyof VisitIn;
export type TaskCompleteField = keyof TaskCompleteIn;

export type FieldErrors<F extends string> = Partial<Record<F, MessageKey>>;

export type ValidationResult<T, F extends string> =
  | { ok: true; value: T; errors: FieldErrors<F> }
  | { ok: false; value: null; errors: FieldErrors<F> };

export interface ValidateOptions {
  /** Server-time stand-in; defaults to the system clock. */
  clock?: Clock;
}

export interface VisitValidateOptions extends ValidateOptions {
  /** The mother's LMP ("YYYY-MM-DD"); enables "visit date not before LMP". */
  lmpDate?: string | null;
}

/** The first error key in field order, or null (for a summary line or logging). */
export function firstError<F extends string>(errors: FieldErrors<F>): MessageKey | null {
  for (const key of Object.keys(errors) as F[]) {
    const v = errors[key];
    if (v) return v;
  }
  return null;
}

// --------------------------------------------------------------------------- primitives

type Check<T> = { ok: true; value: T } | { ok: false; error: MessageKey };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = <T>(error: MessageKey): Check<T> => ({ ok: false, error });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Field present and not null (pydantic treats an explicit null as "absent" for optionals). */
const isAbsent = (v: unknown): v is null | undefined => v === undefined || v === null;

/** Length in Unicode code points, as Python `len(str)` counts. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/**
 * Python `round(x, ndigits)`: rounds the exact binary value, ties to even.
 * Ties are only possible when the double is exactly representable at ndigits + 1.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const exact = x.toFixed(100); // exact decimal expansion of the double
  const dot = exact.indexOf('.');
  const rest = exact.slice(dot + 1 + ndigits);
  if (/^50*$/.test(rest)) {
    const truncated = exact.slice(0, dot + 1 + ndigits);
    const lastDigit = Number(truncated.replace('.', '').slice(-1));
    if (lastDigit % 2 === 0) return Number(truncated);
  }
  return Number(x.toFixed(ndigits));
}

/** Canonical UUID (any case) → lowercase, else null. */
export function normalizeUuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Strict "YYYY-MM-DD" real calendar date (year ≥ 1, as Python `date`). */
export function isStrictIsoDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && Number(v.slice(0, 4)) >= 1 && !Number.isNaN(parseIsoDate(v));
}

/**
 * Parse an ISO-8601 datetime with a timezone to epoch microseconds (UTC), or NaN.
 * Microseconds keep the "+24 h" comparison exact for Python's 6-digit fractions.
 */
export function parseClientDatetime(v: unknown): number {
  if (typeof v !== 'string') return Number.NaN;
  const m = DATETIME_RE.exec(v);
  if (!m) return Number.NaN;
  const [, y, mo, d, hh, mm, ss, frac, z, sign, oh, om] = m;
  const date = `${y}-${mo}-${d}`;
  if (!isStrictIsoDate(date)) return Number.NaN;
  const h = Number(hh);
  const mi = Number(mm);
  const s = ss === undefined ? 0 : Number(ss);
  if (h > 23 || mi > 59 || s > 59) return Number.NaN;
  let offsetMin = 0;
  if (!z) {
    const ohN = Number(oh);
    const omN = Number(om);
    if (ohN > 23 || omN > 59) return Number.NaN;
    offsetMin = (sign === '-' ? -1 : 1) * (ohN * 60 + omN);
  }
  const micros = frac === undefined ? 0 : Number(frac.padEnd(6, '0'));
  const ms = parseIsoDate(date) + ((h * 60 + mi - offsetMin) * 60 + s) * 1000;
  return ms * 1000 + micros;
}

function checkUuid(v: unknown, missing: MessageKey = 'validation.required'): Check<string> {
  if (isAbsent(v)) return fail(missing);
  const id = normalizeUuid(v);
  return id === null ? fail(missing) : ok(id);
}

function checkName(v: unknown): Check<string> {
  if (isAbsent(v)) return fail('validation.required');
  if (typeof v !== 'string') return fail('validation.nameLength');
  const s = v.trim();
  if (s.length === 0) return fail('validation.required');
  return codePointLength(s) > NAME_MAX ? fail('validation.nameLength') : ok(s);
}

function checkStrictInt(v: unknown, min: number, max: number, range: MessageKey): Check<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail('validation.number');
  if (!Number.isInteger(v)) return fail('validation.integer');
  return v < min || v > max ? fail(range) : ok(v);
}

function checkFloat(v: unknown, min: number, max: number, range: MessageKey): Check<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail('validation.number');
  return v < min || v > max ? fail(range) : ok(v);
}

function checkDatetime(v: unknown, nowMs: number): Check<string> {
  if (isAbsent(v)) return fail('validation.required');
  const micros = parseClientDatetime(v);
  if (Number.isNaN(micros)) return fail('validation.date');
  if (micros > (nowMs + FUTURE_SKEW_MS) * 1000) return fail('validation.date');
  return ok(toIsoZ(Math.floor(micros / 1000)));
}

function checkOptionalString(v: unknown, max: number, tooLong: MessageKey): Check<string | null> {
  if (isAbsent(v)) return ok(null);
  if (typeof v !== 'string') return fail(tooLong);
  return codePointLength(v) > max ? fail(tooLong) : ok(v);
}

function checkOptionalBool(v: unknown): Check<boolean | null> {
  if (isAbsent(v)) return ok(null);
  return typeof v === 'boolean' ? ok(v) : fail('validation.required');
}

function checkOptionalLiteral<T extends string>(v: unknown, allowed: readonly T[], bad: MessageKey): Check<T | null> {
  if (isAbsent(v)) return ok(null);
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? ok(v as T) : fail(bad);
}

/** Runs field checks, collecting values and errors. */
class Collector<F extends string> {
  readonly errors: FieldErrors<F> = {};
  readonly values: Partial<Record<F, unknown>> = {};

  take<T>(field: F, check: Check<T>): T | undefined {
    if (check.ok) {
      this.values[field] = check.value;
      return check.value;
    }
    this.errors[field] ??= check.error;
    return undefined;
  }

  error(field: F, key: MessageKey): void {
    this.errors[field] ??= key;
  }

  get failed(): boolean {
    return Object.keys(this.errors).length > 0;
  }

  result<T>(): ValidationResult<T, F> {
    return this.failed
      ? { ok: false, value: null, errors: this.errors }
      : { ok: true, value: this.values as unknown as T, errors: this.errors };
  }
}

// --------------------------------------------------------------------------- mother

/** `mother/upsert` data, as `MotherIn` (Req 11.1–11.8). */
export function validateMother(data: unknown, opts: ValidateOptions = {}): ValidationResult<MotherIn, MotherField> {
  const nowMs = (opts.clock ?? systemClock)();
  const c = new Collector<MotherField>();
  const d = isRecord(data) ? data : {};

  c.take('id', checkUuid(d.id));
  c.take('full_name', checkName(d.full_name));
  if (isAbsent(d.age)) c.error('age', 'validation.required');
  else c.take('age', checkStrictInt(d.age, AGE_MIN, AGE_MAX, 'validation.ageRange'));
  c.take('guardian_name', checkName(d.guardian_name));
  c.take('village_id', checkUuid(d.village_id, 'validation.village'));

  // Phone: blank → absent; otherwise a 10-digit Indian mobile number.
  const phone = typeof d.phone === 'string' && d.phone.trim() === '' ? null : d.phone;
  if (isAbsent(phone)) c.take('phone', ok(null));
  else if (typeof phone === 'string' && PHONE_RE.test(phone)) c.take('phone', ok(phone));
  else c.error('phone', 'validation.phone');

  let lmp: string | undefined;
  if (isAbsent(d.lmp_date)) c.error('lmp_date', 'validation.required');
  else if (!isStrictIsoDate(d.lmp_date)) c.error('lmp_date', 'validation.date');
  else if (d.lmp_date > istDate(nowMs)) c.error('lmp_date', 'validation.lmpFuture');
  else lmp = c.take('lmp_date', ok(d.lmp_date));

  if (typeof d.is_bpl === 'boolean') c.take('is_bpl', ok(d.is_bpl));
  else c.error('is_bpl', 'validation.required');

  if (isAbsent(d.height_cm)) c.take('height_cm', ok(null));
  else c.take('height_cm', checkFloat(d.height_cm, HEIGHT_MIN, HEIGHT_MAX, 'validation.heightRange'));

  if (isAbsent(d.first_weight_kg)) c.take('first_weight_kg', ok(null));
  else {
    const w = checkFloat(d.first_weight_kg, WEIGHT_MIN, WEIGHT_MAX, 'validation.weightRange');
    c.take('first_weight_kg', w.ok ? ok(pyRound(w.value, 2)) : w);
  }

  const registeredAt = c.take('registered_at', checkDatetime(d.registered_at, nowMs));
  c.take('updated_at', checkDatetime(d.updated_at, nowMs));

  // Model rule: 0 <= GA at the IST registration date <= 308 (only when all fields pass).
  if (!c.failed && lmp !== undefined && registeredAt !== undefined) {
    const ga = gaDays(lmp, istDate(Date.parse(registeredAt)));
    if (ga < 0 || ga > GA_AT_REGISTRATION_MAX) c.error('lmp_date', 'validation.lmpRange');
  }
  return c.result<MotherIn>();
}

// --------------------------------------------------------------------------- visit

/** `visit/create` data, as `VisitIn` (Req 11.1, 11.7–11.15). */
export function validateVisit(data: unknown, opts: VisitValidateOptions = {}): ValidationResult<VisitIn, VisitField> {
  const clock = opts.clock ?? systemClock;
  const nowMs = clock();
  const c = new Collector<VisitField>();
  const d = isRecord(data) ? data : {};

  c.take('id', checkUuid(d.id));
  c.take('mother_id', checkUuid(d.mother_id));

  if (isAbsent(d.visit_date)) c.error('visit_date', 'validation.required');
  else if (!isStrictIsoDate(d.visit_date)) c.error('visit_date', 'validation.date');
  else if (opts.lmpDate && isStrictIsoDate(opts.lmpDate) && d.visit_date < opts.lmpDate)
    c.error('visit_date', 'validation.visitBeforeLmp');
  else if (d.visit_date > addDays(todayIST(clock), 1)) c.error('visit_date', 'validation.visitFuture');
  else c.take('visit_date', ok(d.visit_date));

  let weight: number | null | undefined = null;
  if (!isAbsent(d.weight_kg)) {
    const w = checkFloat(d.weight_kg, WEIGHT_MIN, WEIGHT_MAX, 'validation.weightRange');
    weight = c.take('weight_kg', w.ok ? ok(pyRound(w.value, 2)) : w);
  } else c.take('weight_kg', ok(null));
  const weightSource = c.take('weight_source', checkOptionalLiteral(d.weight_source, WEIGHT_SOURCES, 'validation.weightSource'));

  if (isAbsent(d.ble_raw_hex)) c.take('ble_raw_hex', ok(null));
  else if (typeof d.ble_raw_hex === 'string' && BLE_HEX_RE.test(d.ble_raw_hex.toLowerCase().replaceAll(' ', '')))
    c.take('ble_raw_hex', ok(d.ble_raw_hex.toLowerCase().replaceAll(' ', '')));
  else c.error('ble_raw_hex', 'field.scale.implausible');

  let hb: number | null | undefined = null;
  if (!isAbsent(d.hb_gdl)) {
    const h = checkFloat(d.hb_gdl, HB_MIN, HB_MAX, 'validation.hbRange');
    hb = c.take('hb_gdl', h.ok ? ok(pyRound(h.value, 1)) : h);
  } else c.take('hb_gdl', ok(null));
  const hbSource = c.take('hb_source', checkOptionalLiteral(d.hb_source, HB_SOURCES, 'validation.hbSource'));

  const sys = isAbsent(d.bp_systolic)
    ? c.take('bp_systolic', ok(null))
    : c.take('bp_systolic', checkStrictInt(d.bp_systolic, BP_SYS_MIN, BP_SYS_MAX, 'validation.bpSystolicRange'));
  const dia = isAbsent(d.bp_diastolic)
    ? c.take('bp_diastolic', ok(null))
    : c.take('bp_diastolic', checkStrictInt(d.bp_diastolic, BP_DIA_MIN, BP_DIA_MAX, 'validation.bpDiastolicRange'));
  const bpSource = c.take('bp_source', checkOptionalLiteral(d.bp_source, BP_SOURCES, 'validation.bpSource'));

  for (const f of ['ifa_tablets', 'calcium_tablets'] as const) {
    if (isAbsent(d[f])) c.take(f, ok(null));
    else c.take(f, checkStrictInt(d[f], TABLETS_MIN, TABLETS_MAX, 'validation.tabletsRange'));
  }
  c.take('thr_received', checkOptionalBool(d.thr_received));
  c.take('notes', checkOptionalString(d.notes, NOTES_MAX, 'validation.notesLength'));
  c.take('client_created_at', checkDatetime(d.client_created_at, nowMs));

  // Model rules (only when every field passed, as on the server).
  if (!c.failed) {
    if (weight !== null && weightSource === null) c.error('weight_source', 'validation.weightSource');
    if (hb !== null && hbSource === null) c.error('hb_source', 'validation.hbSource');
    if ((sys === null) !== (dia === null)) {
      c.error(sys === null ? 'bp_systolic' : 'bp_diastolic', 'validation.bpBoth');
    } else if (sys != null && dia != null) {
      if (sys <= dia) c.error('bp_systolic', 'validation.bpOrder');
      else if (bpSource === null) c.error('bp_source', 'validation.bpSource');
    }
  }
  return c.result<VisitIn>();
}

// --------------------------------------------------------------------------- task complete

/** `task/complete` data, as `TaskCompleteIn` (Req 11.8, 11.15). */
export function validateTaskComplete(
  data: unknown,
  opts: ValidateOptions = {},
): ValidationResult<TaskCompleteIn, TaskCompleteField> {
  const nowMs = (opts.clock ?? systemClock)();
  const c = new Collector<TaskCompleteField>();
  const d = isRecord(data) ? data : {};
  c.take('id', checkUuid(d.id));
  c.take('done_at', checkDatetime(d.done_at, nowMs));
  c.take('done_note', checkOptionalString(d.done_note, DONE_NOTE_MAX, 'validation.doneNoteLength'));
  return c.result<TaskCompleteIn>();
}

/** The "Mark done" note (optional, at most 300 characters). */
export function validateDoneNote(note: string | null | undefined): MessageKey | null {
  const r = checkOptionalString(note, DONE_NOTE_MAX, 'validation.doneNoteLength');
  return r.ok ? null : r.error;
}

// --------------------------------------------------------------------------- form helpers

// Placeholders for fields the form does not edit (ids and timestamps are set on save).
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Registration/edit form check: validates the client-owned fields with a placeholder
 * id and `registered_at`/`updated_at` = now unless supplied, so only form fields error.
 */
export function validateMotherDraft(
  draft: Record<string, unknown>,
  opts: ValidateOptions = {},
): ValidationResult<MotherIn, MotherField> {
  const now = toIsoZ((opts.clock ?? systemClock)());
  return validateMother(
    { id: PLACEHOLDER_ID, registered_at: now, updated_at: now, ...stripUndefined(draft) },
    opts,
  );
}

/** New-visit form check: placeholder id, `client_created_at` = now. */
export function validateVisitDraft(
  draft: Record<string, unknown>,
  opts: VisitValidateOptions = {},
): ValidationResult<VisitIn, VisitField> {
  const now = toIsoZ((opts.clock ?? systemClock)());
  return validateVisit({ id: PLACEHOLDER_ID, client_created_at: now, ...stripUndefined(draft) }, opts);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export type ParsedInput = { ok: true; value: number | null } | { ok: false; error: MessageKey };

/**
 * Parse a typed number. Blank → null (absent). Accepts ASCII digits with an optional
 * "." or "," decimal separator; `maxDecimals` limits the fraction digits (Hb uses 1).
 */
export function parseNumberInput(text: string, maxDecimals = Infinity): ParsedInput {
  const s = text.trim().replace(',', '.');
  if (s === '') return { ok: true, value: null };
  const m = /^-?[0-9]+(?:\.([0-9]*))?$|^-?\.([0-9]+)$/.exec(s);
  if (!m) return { ok: false, error: 'validation.number' };
  const frac = m[1] ?? m[2] ?? '';
  if (frac.length > maxDecimals) {
    return { ok: false, error: maxDecimals === 0 ? 'validation.integer' : 'validation.hbDecimals' };
  }
  return { ok: true, value: Number(s) };
}

/** Parse a typed whole number (age, BP, tablets). Blank → null. */
export function parseIntegerInput(text: string): ParsedInput {
  return parseNumberInput(text, 0);
}
