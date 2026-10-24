/**
 * Pure data builders for the patient-detail charts (Req 22.3, 22.4, 22.5) and the
 * live-event → detail refetch rule (Req 19.9; design §17 table). No React, no I/O.
 *
 * - Visits are ordered by `visit_date`, then `client_created_at` (the backend order).
 * - Weight gain is measured against the baseline weight (`first_weight_kg`, else
 *   the earliest weighed visit) and plotted at GA weeks against the IOM band.
 * - Each series row has a `label` (the visit date, with " #2", " #3" … for repeat
 *   dates) so category axes and table rows stay unique.
 */
import { gaDays } from '../shared/gestation';
import type { MotherOut, VisitOut } from '../shared/types';
import type { LiveEvent } from './live/useLiveEvents';
import { baselineWeightKg, bmiCategory, referenceBand } from './weightBand';
import type { BmiCategory } from './weightBand';

/** Hb reference lines (g/dL), matching the triage thresholds (Req 22.4). */
export const HB_REFERENCE_LINES = [7, 10, 11] as const;
/** BP reference lines (mmHg): 140/90 high, 160/110 severe (Req 22.4). */
export const BP_SYSTOLIC_LINES = [140, 160] as const;
export const BP_DIASTOLIC_LINES = [90, 110] as const;

/** The band is drawn at least to this GA week, so a full pregnancy is visible. */
export const BAND_MIN_WEEKS = 40;

const round2 = (x: number): number => Math.round(x * 100) / 100;

type VisitOrderFields = Pick<VisitOut, 'visit_date' | 'client_created_at'>;

/** Chronological copy of `visits` (visit_date, then client_created_at). */
export function sortVisits<V extends VisitOrderFields>(visits: readonly V[]): V[] {
  return [...visits].sort((a, b) => {
    if (a.visit_date !== b.visit_date) return a.visit_date < b.visit_date ? -1 : 1;
    if (a.client_created_at !== b.client_created_at) return a.client_created_at < b.client_created_at ? -1 : 1;
    return 0;
  });
}

/** Unique labels: the date, with " #n" appended for the n-th visit on the same date. */
function labelled<V extends VisitOrderFields>(visits: readonly V[]): Array<{ visit: V; label: string }> {
  const seen = new Map<string, number>();
  return visits.map((visit) => {
    const n = (seen.get(visit.visit_date) ?? 0) + 1;
    seen.set(visit.visit_date, n);
    return { visit, label: n === 1 ? visit.visit_date : `${visit.visit_date} #${n}` };
  });
}

// ------------------------------------------------------------------ weight gain

export interface WeightGainPoint {
  /** GA in weeks (fractional at visits). */
  week: number;
  /** Reference band [low, high] in kg of cumulative gain. */
  band: [number, number];
  /** Actual gain since baseline (kg) at a weighed visit, else null. */
  gain: number | null;
  /** Measured weight (kg) at a weighed visit, else null. */
  weightKg: number | null;
  /** Visit date at a weighed visit, else null. */
  date: string | null;
}

export interface WeightGainSeries {
  category: BmiCategory;
  baselineKg: number | null;
  /** Sorted by week; integer weeks carry the band only, visit weeks also carry the gain. */
  points: WeightGainPoint[];
  /** The weighed-visit points only, in order (for the data table). */
  visits: WeightGainPoint[];
}

type WeightMother = Pick<MotherOut, 'lmp_date' | 'first_weight_kg' | 'height_cm'>;
type WeightVisit = Pick<VisitOut, 'visit_date' | 'client_created_at' | 'weight_kg'>;

export function weightGainSeries(mother: WeightMother, visits: readonly WeightVisit[]): WeightGainSeries {
  const baselineKg = baselineWeightKg(mother.first_weight_kg, visits);
  const category = bmiCategory(baselineKg, mother.height_cm);

  const bandAt = (week: number): [number, number] => {
    const b = referenceBand(week, category);
    return [round2(b.low), round2(b.high)];
  };

  const visitPoints: WeightGainPoint[] = [];
  if (baselineKg != null) {
    for (const v of sortVisits(visits)) {
      if (v.weight_kg == null) continue;
      const week = round2(gaDays(mother.lmp_date, v.visit_date) / 7);
      visitPoints.push({
        week,
        band: bandAt(week),
        gain: round2(v.weight_kg - baselineKg),
        weightKg: v.weight_kg,
        date: v.visit_date,
      });
    }
  }

  const lastVisitWeek = visitPoints.length > 0 ? visitPoints[visitPoints.length - 1].week : 0;
  const maxWeek = Math.max(BAND_MIN_WEEKS, Math.ceil(lastVisitWeek));
  const visitWeeks = new Set(visitPoints.map((p) => p.week));
  const points: WeightGainPoint[] = [...visitPoints];
  for (let w = 0; w <= maxWeek; w += 1) {
    if (!visitWeeks.has(w)) points.push({ week: w, band: bandAt(w), gain: null, weightKg: null, date: null });
  }
  points.sort((a, b) => a.week - b.week);

  return { category, baselineKg, points, visits: visitPoints };
}

// ------------------------------------------------------------------ Hb, BP, supplements

export interface HbPoint {
  label: string;
  date: string;
  hb: number;
}

export function hbSeries(visits: readonly VisitOut[]): HbPoint[] {
  return labelled(sortVisits(visits).filter((v) => v.hb_gdl != null)).map(({ visit, label }) => ({
    label,
    date: visit.visit_date,
    hb: visit.hb_gdl as number,
  }));
}

export interface BpPoint {
  label: string;
  date: string;
  systolic: number;
  diastolic: number;
}

export function bpSeries(visits: readonly VisitOut[]): BpPoint[] {
  return labelled(sortVisits(visits).filter((v) => v.bp_systolic != null && v.bp_diastolic != null)).map(
    ({ visit, label }) => ({
      label,
      date: visit.visit_date,
      systolic: visit.bp_systolic as number,
      diastolic: visit.bp_diastolic as number,
    }),
  );
}

export interface SupplementPoint {
  label: string;
  date: string;
  ifa: number | null;
  calcium: number | null;
  thr: boolean | null;
  /** 0 when THR was received (a marker on the baseline), else null (no marker). */
  thrMarker: number | null;
}

/** One row per visit that recorded any supplement field. */
export function supplementSeries(visits: readonly VisitOut[]): SupplementPoint[] {
  return labelled(
    sortVisits(visits).filter((v) => v.ifa_tablets != null || v.calcium_tablets != null || v.thr_received != null),
  ).map(({ visit, label }) => ({
    label,
    date: visit.visit_date,
    ifa: visit.ifa_tablets,
    calcium: visit.calcium_tablets,
    thr: visit.thr_received,
    thrMarker: visit.thr_received ? 0 : null,
  }));
}

/** Axis domain covering `values` and the fixed reference lines, padded by `pad`. */
export function paddedDomain(values: readonly number[], lines: readonly number[], pad: number): [number, number] {
  const all = [...values, ...lines];
  return [Math.max(0, Math.floor(Math.min(...all) - pad)), Math.ceil(Math.max(...all) + pad)];
}

// ------------------------------------------------------------------ live events

/**
 * The mother an event is about, or null (`hello`). Per design §17 the patient
 * detail refetches when this equals the mother on screen:
 * - `alert.created` / `alert.updated`: `alert.mother_id`
 * - `risk.changed`: `mother_id`
 * - `task.done`: `task.mother_id`
 */
export function liveEventMotherId(ev: LiveEvent): string | null {
  switch (ev.type) {
    case 'alert.created':
    case 'alert.updated':
      return ev.data.alert?.mother_id ?? null;
    case 'risk.changed':
      return ev.data.mother_id ?? null;
    case 'task.done':
      return ev.data.task?.mother_id ?? null;
    default:
      return null;
  }
}

/** True when `ev` should refetch the detail of `motherId` (ids compared case-insensitively). */
export function shouldRefetchDetail(ev: LiveEvent, motherId: string): boolean {
  const id = liveEventMotherId(ev);
  return id != null && id.toLowerCase() === motherId.toLowerCase();
}
