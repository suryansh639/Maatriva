import { describe, expect, it } from 'vitest';

import { readingFromPayload } from './ble/scale';
import { simulatedPayload } from './ble/simulatedScale';
import { applyKeypadKey } from './components/keypad';
import type { KeypadKey } from './components/keypad';
import {
  initialVisitForm,
  initials,
  lastWeightKg,
  needsMotherConfirm,
  readCarriedDraft,
  resolveWeight,
  validateVisitForm,
  type VisitFormState,
} from './visitForm';
import type { LocalVisit } from '../shared/types';

const MOTHER_ID = '00000000-0000-4000-8000-000000000001';
const LMP = '2025-01-01';
// 2025-06-10 11:30 IST.
const clock = () => Date.parse('2025-06-10T06:00:00Z');
const TODAY = '2025-06-10';

function form(over: Partial<VisitFormState> = {}): VisitFormState {
  return { ...initialVisitForm(TODAY), ...over };
}

const simulatedReading = (kg: number) => readingFromPayload(simulatedPayload(kg, new Date(2025, 5, 10, 11, 30)), 'simulated', new Date());

function validate(f: VisitFormState) {
  return validateVisitForm(f, MOTHER_ID, { lmpDate: LMP, clock });
}

describe('validateVisitForm', () => {
  it('accepts the demo visit: simulated 56.6 kg and Hb 6.8, with the raw hex and sources', () => {
    const reading = simulatedReading(56.6);
    const r = validate(form({ weightMode: 'simulated', reading, hb: '6.8' }));
    expect(r.valid).toBe(true);
    expect(r.draft).toMatchObject({
      mother_id: MOTHER_ID,
      visit_date: TODAY,
      weight_kg: 56.6,
      weight_source: 'simulated',
      ble_raw_hex: reading.rawHex,
      hb_gdl: 6.8,
      hb_source: 'manual',
      bp_systolic: null,
      bp_source: null,
      thr_received: null,
      notes: null,
    });
    expect(r.draft?.ble_raw_hex).toMatch(/^06/);
  });

  it('accepts an empty visit (only the date)', () => {
    const r = validate(form());
    expect(r.valid).toBe(true);
    expect(r.draft?.weight_kg).toBeNull();
    expect(r.draft?.hb_source).toBeNull();
  });

  it('enforces the Hb range 3.0–20.0 and one decimal place', () => {
    expect(validate(form({ hb: '3.0' })).valid).toBe(true);
    expect(validate(form({ hb: '20.0' })).valid).toBe(true);
    expect(validate(form({ hb: '2.9' })).errors.hb_gdl).toBe('validation.hbRange');
    expect(validate(form({ hb: '20.1' })).errors.hb_gdl).toBe('validation.hbRange');
    expect(validate(form({ hb: '6.85' })).errors.hb_gdl).toBe('validation.hbDecimals');
    expect(validate(form({ hb: 'abc' })).errors.hb_gdl).toBe('validation.number');
  });

  it('stores the chosen Hb source', () => {
    expect(validate(form({ hb: '11.2', hb_source: 'device' })).draft?.hb_source).toBe('device');
  });

  it('needs both BP values, systolic above diastolic, and sets bp_source manual', () => {
    const one = validate(form({ bp_systolic: '120' }));
    expect(one.valid).toBe(false);
    expect(one.errors.bp_diastolic).toBe('validation.bpBoth');
    expect(validate(form({ bp_systolic: '80', bp_diastolic: '90' })).errors.bp_systolic).toBe('validation.bpOrder');
    const both = validate(form({ bp_systolic: '120', bp_diastolic: '80' }));
    expect(both.valid).toBe(true);
    expect(both.draft).toMatchObject({ bp_systolic: 120, bp_diastolic: 80, bp_source: 'manual' });
  });

  it('checks the visit date against LMP and tomorrow (IST)', () => {
    expect(validate(form({ visit_date: '2024-12-31' })).errors.visit_date).toBe('validation.visitBeforeLmp');
    expect(validate(form({ visit_date: '2025-06-11' })).valid).toBe(true);
    expect(validate(form({ visit_date: '2025-06-12' })).errors.visit_date).toBe('validation.visitFuture');
    expect(validate(form({ visit_date: '' })).errors.visit_date).toBe('validation.required');
  });

  it('validates tablets, typed weight, THR and notes', () => {
    expect(validate(form({ ifa_tablets: '181' })).errors.ifa_tablets).toBe('validation.tabletsRange');
    expect(validate(form({ calcium_tablets: '1.5' })).errors.calcium_tablets).toBe('validation.integer');
    expect(validate(form({ weight: '24.9' })).errors.weight_kg).toBe('validation.weightRange');
    expect(validate(form({ notes: 'x'.repeat(501) })).errors.notes).toBe('validation.notesLength');
    const ok = validate(form({ weight: '55,25', thr: 'no', ifa_tablets: '30', notes: 'ok' }));
    expect(ok.draft).toMatchObject({ weight_kg: 55.25, weight_source: 'manual', ble_raw_hex: null, thr_received: false, ifa_tablets: 30, notes: 'ok' });
  });
});

describe('resolveWeight / needsMotherConfirm', () => {
  it('requires confirmation only for a usable device reading', () => {
    expect(needsMotherConfirm(form({ weight: '56.6' }))).toBe(false);
    expect(needsMotherConfirm(form({ weightMode: 'simulated' }))).toBe(false);
    expect(needsMotherConfirm(form({ weightMode: 'simulated', reading: simulatedReading(56.6) }))).toBe(true);
    const ble = { ...simulatedReading(60), source: 'ble' as const };
    expect(needsMotherConfirm(form({ weightMode: 'ble', reading: ble }))).toBe(true);
    expect(resolveWeight(form({ weightMode: 'ble', reading: ble })).weight_source).toBe('ble');
  });

  it('ignores an implausible reading and a reading left over in manual mode', () => {
    expect(resolveWeight(form({ weightMode: 'simulated', reading: simulatedReading(20) })).weight_kg).toBeNull();
    expect(resolveWeight(form({ weightMode: 'manual', reading: simulatedReading(56.6) })).weight_source).toBeNull();
  });
});

describe('helpers', () => {
  const visit = (date: string, w: number | null, created = `${date}T05:00:00Z`) =>
    ({ visit_date: date, weight_kg: w, client_created_at: created }) as LocalVisit;

  it('lastWeightKg uses the latest weighed visit, else the registration weight', () => {
    expect(lastWeightKg({ first_weight_kg: 50 }, [])).toBe(50);
    expect(lastWeightKg({ first_weight_kg: null }, [])).toBeNull();
    expect(
      lastWeightKg({ first_weight_kg: 50 }, [
        visit('2025-05-01', 58),
        visit('2025-05-20', null),
        visit('2025-04-01', 56),
        visit('2025-05-01', 58.4, '2025-05-01T09:00:00Z'),
      ]),
    ).toBe(58.4);
  });

  it('initials skips the bracketed tag', () => {
    expect(initials('Sunita Demo (synthetic)')).toBe('SD');
    expect(initials('asha')).toBe('A');
    expect(initials('  ')).toBe('?');
  });

  it('readCarriedDraft accepts only a carried form', () => {
    const f = form({ hb: '6.8' });
    expect(readCarriedDraft({ carriedDraft: f })).toBe(f);
    expect(readCarriedDraft(null)).toBeNull();
    expect(readCarriedDraft({ saved: true })).toBeNull();
  });
});

describe('applyKeypadKey', () => {
  const hb = { maxDecimals: 1, maxLength: 4 };
  const press = (keys: KeypadKey[]) => keys.reduce((v, k) => applyKeypadKey(v, k, hb), '');

  it('types 6.8 and stops after one decimal', () => {
    expect(press(['6', '.', '8'])).toBe('6.8');
    expect(press(['6', '.', '8', '5'])).toBe('6.8');
    expect(press(['.', '5'])).toBe('0.5');
    expect(press(['1', '.', '.', '2'])).toBe('1.2');
    expect(press(['0', '7'])).toBe('7');
    expect(press(['1', '2', '.', '5', 'backspace'])).toBe('12.');
    expect(press(['1', '2', 'clear'])).toBe('');
  });

  it('respects maxLength and treats a typed "," as the decimal mark', () => {
    expect(press(['1', '9', '.', '9'])).toBe('19.9');
    expect(press(['1', '2', '3', '4', '5'])).toBe('1234');
    expect(applyKeypadKey('6,', '8', hb)).toBe('6.8');
    expect(applyKeypadKey('6,8', '.', hb)).toBe('6,8');
  });
});
