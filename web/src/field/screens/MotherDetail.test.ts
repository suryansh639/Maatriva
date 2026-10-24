import { describe, expect, it } from 'vitest';

import type { LocalMother, LocalVisit } from '../../shared/types';
import { weightPoints } from './MotherDetail';

const MOTHER_ID = '00000000-0000-4000-8000-000000000001';

function mother(over: Partial<LocalMother> = {}): LocalMother {
  return {
    id: MOTHER_ID,
    full_name: 'Sunita Demo (synthetic)',
    age: 24,
    guardian_name: 'Ramesh Demo',
    village_id: '00000000-0000-4000-8000-0000000000aa',
    phone: null,
    lmp_date: '2025-01-01',
    is_bpl: false,
    height_cm: 155,
    first_weight_kg: null,
    // 2025-02-01 IST
    registered_at: '2025-02-01T03:30:00Z',
    updated_at: '2025-02-01T03:30:00Z',
    risk_level: null,
    risk_updated_at: null,
    edd_date: null,
    status: null,
    flags: [],
    ...over,
  };
}

function visit(id: string, date: string, weight: number | null, created = `${date}T05:00:00Z`): LocalVisit {
  return {
    id,
    mother_id: MOTHER_ID,
    visit_date: date,
    weight_kg: weight,
    weight_source: weight === null ? null : 'manual',
    ble_raw_hex: null,
    hb_gdl: null,
    hb_source: null,
    bp_systolic: null,
    bp_diastolic: null,
    bp_source: null,
    ifa_tablets: null,
    calcium_tablets: null,
    thr_received: null,
    notes: null,
    client_created_at: created,
    device_id: null,
    recorded_by_id: null,
    received_at: null,
  };
}

describe('weightPoints', () => {
  it('orders visit weights by visit_date then client_created_at and skips unweighed visits', () => {
    const pts = weightPoints(mother(), [
      visit('c', '2025-04-01', 56.6, '2025-04-01T09:00:00Z'),
      visit('a', '2025-03-01', 58),
      visit('b', '2025-03-15', null),
      visit('d', '2025-04-01', 56.2, '2025-04-01T08:00:00Z'),
    ]);
    expect(pts).toEqual([
      { date: '2025-03-01', weightKg: 58 },
      { date: '2025-04-01', weightKg: 56.2 },
      { date: '2025-04-01', weightKg: 56.6 },
    ]);
  });

  it('adds the registration weight at the IST registration date', () => {
    const pts = weightPoints(mother({ first_weight_kg: 52, registered_at: '2025-01-31T20:00:00Z' }), [
      visit('a', '2025-03-01', 54),
    ]);
    expect(pts).toEqual([
      { date: '2025-02-01', weightKg: 52 },
      { date: '2025-03-01', weightKg: 54 },
    ]);
  });

  it('does not duplicate the registration weight when a visit has the same date', () => {
    const pts = weightPoints(mother({ first_weight_kg: 52 }), [visit('a', '2025-02-01', 52.1)]);
    expect(pts).toEqual([{ date: '2025-02-01', weightKg: 52.1 }]);
  });

  it('returns fewer than 2 points for a mother with a single weight (chart empty state)', () => {
    expect(weightPoints(mother({ first_weight_kg: 50 }), [])).toHaveLength(1);
    expect(weightPoints(mother(), [])).toHaveLength(0);
  });
});
