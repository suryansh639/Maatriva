/**
 * Pure logic behind the new-visit screen (Req 30.1–30.6, 29.7).
 *
 * - `VisitFormState` is the editable text of the form plus the weight mode and the
 *   scale reading. It is plain data, so "Choose another mother" can carry it to
 *   another mother's visit through router state (Req 30.5).
 * - `resolveWeight` turns the weight block into `weight_kg` / `weight_source` /
 *   `ble_raw_hex`: typed → `manual`; a scale reading → its source (`ble` or
 *   `simulated`) and the raw 0x2A9D hex (Req 30.6).
 * - `validateVisitForm` parses the typed numbers and runs `validateVisitDraft`
 *   (the client mirror of Requirement 11) with the mother's LMP.
 * - `needsMotherConfirm`: a device reading must be confirmed before saving (Req 30.3).
 */
import type { MessageKey } from '../shared/i18n';
import type { HbSource, LocalMother, LocalVisit, VisitIn, WeightSource } from '../shared/types';
import { isUsableReading } from './ble/scale';
import type { ScaleReading } from './ble/scale';
import type { VisitDraft } from './outbox';
import {
  parseIntegerInput,
  parseNumberInput,
  validateVisitDraft,
  type FieldErrors,
  type VisitField,
} from './validation';
import type { Clock } from '../shared/time';

export type WeightMode = 'manual' | 'simulated' | 'ble';
export type ThrAnswer = '' | 'yes' | 'no';

export interface VisitFormState {
  visit_date: string;
  weightMode: WeightMode;
  /** Typed weight (manual mode). */
  weight: string;
  /** Accepted scale reading (simulated / Bluetooth modes). */
  reading: ScaleReading | null;
  hb: string;
  hb_source: HbSource;
  bp_systolic: string;
  bp_diastolic: string;
  ifa_tablets: string;
  calcium_tablets: string;
  thr: ThrAnswer;
  notes: string;
}

export function initialVisitForm(today: string): VisitFormState {
  return {
    visit_date: today,
    weightMode: 'manual',
    weight: '',
    reading: null,
    hb: '',
    hb_source: 'manual',
    bp_systolic: '',
    bp_diastolic: '',
    ifa_tablets: '',
    calcium_tablets: '',
    thr: '',
    notes: '',
  };
}

export interface ResolvedWeight {
  weight_kg: number | null;
  weight_source: WeightSource | null;
  ble_raw_hex: string | null;
  error?: MessageKey;
}

/** The weight block as visit fields. An unusable reading counts as no weight. */
export function resolveWeight(form: Pick<VisitFormState, 'weightMode' | 'weight' | 'reading'>): ResolvedWeight {
  if (form.weightMode === 'manual') {
    const w = parseNumberInput(form.weight);
    if (!w.ok) return { weight_kg: null, weight_source: null, ble_raw_hex: null, error: w.error };
    return { weight_kg: w.value, weight_source: w.value === null ? null : 'manual', ble_raw_hex: null };
  }
  const r = form.reading;
  if (!isUsableReading(r) || r.weightKg === null) return { weight_kg: null, weight_source: null, ble_raw_hex: null };
  return { weight_kg: r.weightKg, weight_source: r.source, ble_raw_hex: r.rawHex };
}

/** True when Save must first show the mother confirmation (a `ble`/`simulated` reading). */
export function needsMotherConfirm(form: Pick<VisitFormState, 'weightMode' | 'weight' | 'reading'>): boolean {
  const w = resolveWeight(form);
  return w.weight_source === 'ble' || w.weight_source === 'simulated';
}

export interface VisitFormResult {
  valid: boolean;
  errors: FieldErrors<VisitField>;
  /** The draft to pass to `saveVisit` when valid. */
  draft: VisitDraft | null;
}

export interface VisitFormOptions {
  lmpDate?: string | null;
  clock?: Clock;
}

/** Parse and validate the whole form for `motherId`. */
export function validateVisitForm(
  form: VisitFormState,
  motherId: string,
  opts: VisitFormOptions = {},
): VisitFormResult {
  const parseErrors: FieldErrors<VisitField> = {};
  const weight = resolveWeight(form);
  if (weight.error) parseErrors.weight_kg = weight.error;

  const hb = parseNumberInput(form.hb, 1);
  if (!hb.ok) parseErrors.hb_gdl = hb.error;
  const sys = parseIntegerInput(form.bp_systolic);
  if (!sys.ok) parseErrors.bp_systolic = sys.error;
  const dia = parseIntegerInput(form.bp_diastolic);
  if (!dia.ok) parseErrors.bp_diastolic = dia.error;
  const ifa = parseIntegerInput(form.ifa_tablets);
  if (!ifa.ok) parseErrors.ifa_tablets = ifa.error;
  const calcium = parseIntegerInput(form.calcium_tablets);
  if (!calcium.ok) parseErrors.calcium_tablets = calcium.error;

  const hbValue = hb.ok ? hb.value : null;
  const sysValue = sys.ok ? sys.value : null;
  const diaValue = dia.ok ? dia.value : null;
  const notes = form.notes.trim() === '' ? null : form.notes;

  const raw: Omit<VisitIn, 'id' | 'client_created_at'> = {
    mother_id: motherId,
    visit_date: form.visit_date,
    weight_kg: weight.weight_kg,
    weight_source: weight.weight_source,
    ble_raw_hex: weight.ble_raw_hex,
    hb_gdl: hbValue,
    hb_source: hbValue === null ? null : form.hb_source,
    bp_systolic: sysValue,
    bp_diastolic: diaValue,
    // Typed BP is manual; the BLE BP cuff is out of MVP scope.
    bp_source: sysValue !== null || diaValue !== null ? 'manual' : null,
    ifa_tablets: ifa.ok ? ifa.value : null,
    calcium_tablets: calcium.ok ? calcium.value : null,
    thr_received: form.thr === '' ? null : form.thr === 'yes',
    notes,
  };

  const result = validateVisitDraft(
    { ...raw, visit_date: form.visit_date === '' ? null : form.visit_date },
    { lmpDate: opts.lmpDate, clock: opts.clock },
  );
  const errors: FieldErrors<VisitField> = { ...result.errors, ...parseErrors };
  const valid = result.ok && Object.keys(parseErrors).length === 0;
  if (!valid || !result.value) return { valid: false, errors, draft: null };

  const v = result.value;
  const draft: VisitDraft = {
    mother_id: v.mother_id,
    visit_date: v.visit_date,
    weight_kg: v.weight_kg ?? null,
    weight_source: v.weight_source ?? null,
    ble_raw_hex: v.ble_raw_hex ?? null,
    hb_gdl: v.hb_gdl ?? null,
    hb_source: v.hb_source ?? null,
    bp_systolic: v.bp_systolic ?? null,
    bp_diastolic: v.bp_diastolic ?? null,
    bp_source: v.bp_source ?? null,
    ifa_tablets: v.ifa_tablets ?? null,
    calcium_tablets: v.calcium_tablets ?? null,
    thr_received: v.thr_received ?? null,
    notes: v.notes ?? null,
  };
  return { valid: true, errors, draft };
}

/** Last recorded weight: the latest weighed visit (visit_date, client_created_at), else the registration weight. */
export function lastWeightKg(mother: Pick<LocalMother, 'first_weight_kg'>, visits: readonly LocalVisit[]): number | null {
  let best: LocalVisit | null = null;
  for (const v of visits) {
    if (typeof v.weight_kg !== 'number') continue;
    if (
      !best ||
      v.visit_date > best.visit_date ||
      (v.visit_date === best.visit_date && v.client_created_at > best.client_created_at)
    ) {
      best = v;
    }
  }
  if (best) return best.weight_kg as number;
  return typeof mother.first_weight_kg === 'number' ? mother.first_weight_kg : null;
}

/** Up to two initials for the avatar: "Sunita Demo (synthetic)" → "SD". */
export function initials(name: string): string {
  const words = name
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toLocaleUpperCase() || '?';
}

/** Router state for "Choose another mother": the unsaved form moves with the reading. */
export interface CarriedVisitState {
  carriedDraft: VisitFormState;
}

export function readCarriedDraft(state: unknown): VisitFormState | null {
  if (typeof state !== 'object' || state === null) return null;
  const d = (state as Partial<CarriedVisitState>).carriedDraft;
  return d && typeof d === 'object' && typeof d.visit_date === 'string' ? d : null;
}
