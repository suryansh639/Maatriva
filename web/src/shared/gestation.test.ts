/**
 * Gestation unit tests (Requirements 4.1, 4.2, 4.3, 4.4, 44.6).
 *
 * `gestation.vectors.json` was generated from backend/app/gestation.py, so the
 * agreement test checks that the TypeScript port matches the Python source.
 */
import { describe, expect, it } from 'vitest';
import { addMonthsClamped, eddNaegele, gaDays, gaLabel, trimester } from './gestation';
import { istDate, todayIST } from './time';
import vectorFile from './gestation.vectors.json';

interface GestationVector {
  lmp: string;
  on: string;
  ga_days: number;
  ga_label: string;
  edd: string;
  trimester: number;
}

const vectors: GestationVector[] = vectorFile.vectors;

describe('eddNaegele', () => {
  it.each([
    ['2024-01-01', '2024-10-08'],
    ['2024-05-25', '2025-03-01'],
    ['2023-05-24', '2024-02-29'], // leap-year Feb 29
    ['2022-05-24', '2023-02-28'], // clamped to Feb 28
  ])('LMP %s gives EDD %s', (lmp, edd) => {
    expect(eddNaegele(lmp)).toBe(edd);
  });

  it('rejects an invalid date', () => {
    expect(() => eddNaegele('2023-02-30')).toThrow(RangeError);
  });
});

describe('addMonthsClamped', () => {
  it('clamps the day to the target month end', () => {
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsClamped('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonthsClamped('2023-08-31', 9)).toBe('2024-05-31');
    expect(addMonthsClamped('2023-05-31', 10)).toBe('2024-03-31');
  });
});

describe('trimester', () => {
  it.each([
    [0, 1],
    [97, 1],
    [98, 2],
    [195, 2],
    [196, 3],
    [308, 3],
  ])('GA %i days is trimester %i', (ga, expected) => {
    expect(trimester(ga)).toBe(expected);
  });
});

describe('gaDays', () => {
  it('counts days from LMP', () => {
    expect(gaDays('2024-01-01', '2024-01-01')).toBe(0);
    expect(gaDays('2024-01-01', '2024-03-01')).toBe(60); // spans leap Feb
  });
});

describe('gaLabel', () => {
  it.each([
    [0, '0w 0d'],
    [6, '0w 6d'],
    [7, '1w 0d'],
    [182, '26w 0d'],
    [185, '26w 3d'],
    [-3, '-1w 4d'], // Python floor division / modulo
  ])('%i days is "%s"', (days, label) => {
    expect(gaLabel(days)).toBe(label);
  });
});

describe('IST date', () => {
  it('rolls over to the next day at 18:30 UTC', () => {
    expect(istDate(Date.parse('2024-03-10T18:29:59.999Z'))).toBe('2024-03-10');
    expect(istDate(Date.parse('2024-03-10T18:30:00.000Z'))).toBe('2024-03-11');
  });

  it('todayIST uses the injected clock', () => {
    expect(todayIST(() => Date.parse('2024-12-31T18:30:00Z'))).toBe('2025-01-01');
    expect(todayIST(() => Date.parse('2024-12-31T18:29:00Z'))).toBe('2024-12-31');
  });
});

describe('agreement with backend vectors', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it.each(vectors.map((v) => [v.lmp, v.on, v] as const))(
    'LMP %s on %s matches backend/app/gestation.py',
    (_lmp, _on, v) => {
      const ga = gaDays(v.lmp, v.on);
      expect(ga).toBe(v.ga_days);
      expect(gaLabel(ga)).toBe(v.ga_label);
      expect(eddNaegele(v.lmp)).toBe(v.edd);
      expect(trimester(ga)).toBe(v.trimester);
    },
  );
});
