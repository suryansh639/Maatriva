/**
 * Weight-gain reference band for the patient-detail chart (Req 22.3).
 *
 * This is a reference band for display only, not clinical guidance. The numbers
 * follow IOM 2009 and must be validated by a clinician before real use.
 *
 * - The baseline weight is `first_weight_kg`, or the earliest visit weight.
 * - The BMI category comes from the baseline weight and height. Unknown height
 *   uses "normal".
 * - Cumulative expected gain at GA week `w`:
 *   - weeks 0–13 rise linearly from (0, 0) to (0.5, 2.0) kg;
 *   - after week 13, the category's (low, high) kg/week rates are added.
 */

export const REFERENCE_BAND_LABEL =
  'Reference band (IOM 2009, demo only – clinician validation required)';

export type BmiCategory = 'underweight' | 'normal' | 'overweight' | 'obese';

export interface Band {
  low: number;
  high: number;
}

/** First-trimester end week and the cumulative gain (kg) reached by then. */
export const FIRST_TRIMESTER_WEEKS = 13;
export const FIRST_TRIMESTER_GAIN: Readonly<Band> = { low: 0.5, high: 2.0 };

/** IOM 2009 weekly gain rates (kg/week) after the first trimester. */
export const WEEKLY_RATES: Readonly<Record<BmiCategory, Readonly<Band>>> = {
  underweight: { low: 0.44, high: 0.58 },
  normal: { low: 0.35, high: 0.5 },
  overweight: { low: 0.23, high: 0.33 },
  obese: { low: 0.17, high: 0.27 },
};

/** BMI category from a baseline weight and height; unknown height → "normal". */
export function bmiCategory(weightKg: number | null, heightCm: number | null): BmiCategory {
  if (
    weightKg == null ||
    heightCm == null ||
    !Number.isFinite(weightKg) ||
    !Number.isFinite(heightCm) ||
    weightKg <= 0 ||
    heightCm <= 0
  ) {
    return 'normal';
  }
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  if (bmi < 18.5) return 'underweight';
  if (bmi < 25) return 'normal';
  if (bmi < 30) return 'overweight';
  return 'obese';
}

/** Expected cumulative gain (kg) at GA week `gaWeeks`; negative weeks clamp to 0. */
export function referenceBand(gaWeeks: number, category: BmiCategory): Band {
  const w = Math.max(0, gaWeeks);
  if (w <= FIRST_TRIMESTER_WEEKS) {
    const f = w / FIRST_TRIMESTER_WEEKS;
    return { low: FIRST_TRIMESTER_GAIN.low * f, high: FIRST_TRIMESTER_GAIN.high * f };
  }
  const extra = w - FIRST_TRIMESTER_WEEKS;
  const rate = WEEKLY_RATES[category];
  return {
    low: FIRST_TRIMESTER_GAIN.low + extra * rate.low,
    high: FIRST_TRIMESTER_GAIN.high + extra * rate.high,
  };
}

/** Baseline weight: `first_weight_kg`, else the weight of the earliest weighed visit. */
export function baselineWeightKg(
  firstWeightKg: number | null,
  visits: ReadonlyArray<{ visit_date: string; client_created_at: string; weight_kg: number | null }>,
): number | null {
  if (firstWeightKg != null) return firstWeightKg;
  let best: { visit_date: string; client_created_at: string; weight_kg: number } | null = null;
  for (const v of visits) {
    if (v.weight_kg == null) continue;
    if (
      best === null ||
      v.visit_date < best.visit_date ||
      (v.visit_date === best.visit_date && v.client_created_at < best.client_created_at)
    ) {
      best = { visit_date: v.visit_date, client_created_at: v.client_created_at, weight_kg: v.weight_kg };
    }
  }
  return best?.weight_kg ?? null;
}
