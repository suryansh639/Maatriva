import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { kpiCards, markerRadius, percent, villageBounds, villageWorstRisk, villageTotals } from './census';
import type { CensusOut, CensusVillageOut } from '../shared/types';

function village(over: Partial<CensusVillageOut> = {}): CensusVillageOut {
  return {
    id: 'v1',
    name: 'Dankaur',
    lat: 28.35,
    lng: 77.55,
    pregnant: 0,
    bpl: 0,
    red: 0,
    amber: 0,
    green: 0,
    due_this_month: 0,
    ...over,
  };
}

const census: CensusOut = {
  facility: { id: 'f1', name: 'Demo PHC' },
  as_of: '2025-01-15',
  total_pregnant: 120,
  bpl_count: 48,
  by_trimester: { t1: 20, t2: 50, t3: 50 },
  due_this_month: 9,
  risk_counts: { red: 10, amber: 33, green: 77 },
  villages: [],
};

describe('markerRadius', () => {
  it('is 6 + 3·√pregnant', () => {
    expect(markerRadius(0)).toBe(6);
    expect(markerRadius(16)).toBe(18);
    expect(markerRadius(25)).toBe(21);
  });

  it('treats negative or non-finite counts as 0', () => {
    expect(markerRadius(-4)).toBe(6);
    expect(markerRadius(Number.NaN)).toBe(6);
  });

  it('never decreases as the count grows', () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.nat(10_000), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return markerRadius(lo) <= markerRadius(hi);
      }),
    );
  });
});

describe('villageWorstRisk', () => {
  it('picks the worst level present', () => {
    expect(villageWorstRisk(village({ red: 1, amber: 3, green: 5 }))).toBe('RED');
    expect(villageWorstRisk(village({ amber: 1, green: 5 }))).toBe('AMBER');
    expect(villageWorstRisk(village({ green: 2 }))).toBe('GREEN');
    expect(villageWorstRisk(village())).toBeNull();
  });
});

describe('kpiCards', () => {
  it('has the 7 exact Req 20.2 labels in order', () => {
    expect(kpiCards(census).map((c) => c.label)).toEqual([
      'Pregnant women under Demo PHC',
      'From BPL households',
      'Deliveries due this month',
      'By trimester T1/T2/T3',
      'RED – High',
      'AMBER – Watch',
      'GREEN – Routine',
    ]);
  });

  it('formats the values', () => {
    const byKey = Object.fromEntries(kpiCards(census).map((c) => [c.key, c]));
    expect(byKey.pregnant.value).toBe('120');
    expect(byKey.bpl.value).toBe('48');
    expect(byKey.bpl.detail).toBe('40% of pregnant women');
    expect(byKey.trimester.value).toBe('20 / 50 / 50');
    expect(byKey.red.risk).toBe('RED');
    expect(byKey.green.value).toBe('77');
  });
});

describe('percent / totals / bounds', () => {
  it('percent is 0 for an empty total', () => {
    expect(percent(3, 0)).toBe(0);
    expect(percent(1, 3)).toBe(33);
  });

  it('sums village columns', () => {
    const t = villageTotals([village({ pregnant: 3, bpl: 1, red: 1 }), village({ pregnant: 2, green: 2 })]);
    expect(t).toEqual({ pregnant: 5, bpl: 1, red: 1, amber: 0, green: 2, due_this_month: 0 });
  });

  it('frames the villages, skipping missing coordinates', () => {
    expect(villageBounds([])).toBeNull();
    expect(
      villageBounds([
        village({ lat: 28.1, lng: 77.6 }),
        village({ lat: 28.4, lng: 77.4 }),
        village({ lat: Number.NaN, lng: 0 }),
      ]),
    ).toEqual([
      [28.1, 77.4],
      [28.4, 77.6],
    ]);
  });
});
