/**
 * Weight-gain reference band unit tests (Requirements 22.3, 44.6).
 */
import { describe, expect, it } from 'vitest';
import {
  baselineWeightKg,
  bmiCategory,
  referenceBand,
  type Band,
  type BmiCategory,
} from './weightBand';

function expectBand(actual: Band, low: number, high: number): void {
  expect(actual.low).toBeCloseTo(low, 6);
  expect(actual.high).toBeCloseTo(high, 6);
}

describe('referenceBand', () => {
  it('starts at 0/0 at week 0', () => {
    expectBand(referenceBand(0, 'normal'), 0, 0);
  });

  it('reaches 0.5/2.0 at week 13 for every category', () => {
    for (const c of ['underweight', 'normal', 'overweight', 'obese'] as BmiCategory[]) {
      expectBand(referenceBand(13, c), 0.5, 2.0);
    }
  });

  it('rises linearly through the first trimester', () => {
    expectBand(referenceBand(6.5, 'obese'), 0.25, 1.0);
  });

  it('clamps negative weeks to 0', () => {
    expectBand(referenceBand(-4, 'normal'), 0, 0);
  });

  it.each<[BmiCategory, number, number, number, number]>([
    // category, week-20 low/high, week-40 low/high
    ['underweight', 3.58, 6.06, 12.38, 17.66],
    ['normal', 2.95, 5.5, 9.95, 15.5],
    ['overweight', 2.11, 4.31, 6.71, 10.91],
    ['obese', 1.69, 3.89, 5.09, 9.29],
  ])('applies the IOM weekly rates after week 13 (%s)', (c, l20, h20, l40, h40) => {
    expectBand(referenceBand(20, c), l20, h20);
    expectBand(referenceBand(40, c), l40, h40);
  });
});

describe('bmiCategory', () => {
  // Height 100 cm → BMI equals the weight in kg.
  it.each<[number, BmiCategory]>([
    [18.49, 'underweight'],
    [18.5, 'normal'],
    [24.99, 'normal'],
    [25, 'overweight'],
    [29.99, 'overweight'],
    [30, 'obese'],
  ])('BMI %f → %s', (bmi, expected) => {
    expect(bmiCategory(bmi, 100)).toBe(expected);
  });

  it('computes BMI from realistic weight and height', () => {
    // 60 kg / 1.6² ≈ 23.4
    expect(bmiCategory(60, 160)).toBe('normal');
    // 45 kg / 1.6² ≈ 17.6
    expect(bmiCategory(45, 160)).toBe('underweight');
  });

  it('uses "normal" when height or weight is unknown or invalid', () => {
    expect(bmiCategory(45, null)).toBe('normal');
    expect(bmiCategory(null, 160)).toBe('normal');
    expect(bmiCategory(45, 0)).toBe('normal');
    expect(bmiCategory(Number.NaN, 160)).toBe('normal');
  });
});

describe('baselineWeightKg', () => {
  const visits = [
    { visit_date: '2025-03-10', client_created_at: '2025-03-10T09:00:00Z', weight_kg: 52 },
    { visit_date: '2025-02-01', client_created_at: '2025-02-01T10:00:00Z', weight_kg: null },
    { visit_date: '2025-02-15', client_created_at: '2025-02-15T11:00:00Z', weight_kg: 50 },
    { visit_date: '2025-02-15', client_created_at: '2025-02-15T08:00:00Z', weight_kg: 49.5 },
  ];

  it('prefers first_weight_kg when present', () => {
    expect(baselineWeightKg(48, visits)).toBe(48);
  });

  it('falls back to the earliest weighed visit, tie-broken by client_created_at', () => {
    expect(baselineWeightKg(null, visits)).toBe(49.5);
  });

  it('returns null when no weight is known', () => {
    expect(baselineWeightKg(null, [])).toBeNull();
    expect(
      baselineWeightKg(null, [
        { visit_date: '2025-01-01', client_created_at: '2025-01-01T00:00:00Z', weight_kg: null },
      ]),
    ).toBeNull();
  });
});
