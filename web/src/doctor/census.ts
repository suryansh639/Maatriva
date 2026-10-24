/**
 * Pure helpers for the dashboard overview (Req 20.2–20.4). No React, no Leaflet,
 * so they are unit-tested in the node environment.
 */
import type { CensusOut, CensusVillageOut, RiskLevel } from '../shared/types';

/** Circle marker radius in pixels: `6 + 3·√pregnant` (Req 20.4). */
export function markerRadius(pregnant: number): number {
  const n = Number.isFinite(pregnant) && pregnant > 0 ? pregnant : 0;
  return 6 + 3 * Math.sqrt(n);
}

/** Worst risk among a village's active mothers; null when the village has none. */
export function villageWorstRisk(v: Pick<CensusVillageOut, 'red' | 'amber' | 'green'>): RiskLevel | null {
  if (v.red > 0) return 'RED';
  if (v.amber > 0) return 'AMBER';
  if (v.green > 0) return 'GREEN';
  return null;
}

/** Marker tooltip / accessible summary of one village's counts. */
export function villageSummary(v: CensusVillageOut): string {
  return (
    `${v.name}: ${v.pregnant} pregnant, ${v.bpl} BPL, ` +
    `RED ${v.red}, AMBER ${v.amber}, GREEN ${v.green}, ${v.due_this_month} due this month`
  );
}

/** Whole-number percentage of `part` in `total`; 0 when `total` is 0. */
export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export interface KpiCard {
  key: string;
  /** The exact Req 20.2 label. */
  label: string;
  value: string;
  /** Optional secondary line, e.g. the BPL share. */
  detail?: string;
  /** Set on the three risk cards, which render with the risk palette. */
  risk?: RiskLevel;
}

/** The 7 KPI cards of Req 20.2, in display order. */
export function kpiCards(census: CensusOut): KpiCard[] {
  const { total_pregnant: total, by_trimester: t, risk_counts: r } = census;
  return [
    {
      key: 'pregnant',
      label: `Pregnant women under ${census.facility.name}`,
      value: String(total),
    },
    {
      key: 'bpl',
      label: 'From BPL households',
      value: String(census.bpl_count),
      detail: `${percent(census.bpl_count, total)}% of pregnant women`,
    },
    {
      key: 'due',
      label: 'Deliveries due this month',
      value: String(census.due_this_month),
    },
    {
      key: 'trimester',
      label: 'By trimester T1/T2/T3',
      value: `${t.t1} / ${t.t2} / ${t.t3}`,
    },
    { key: 'red', label: 'RED – High', value: String(r.red), risk: 'RED' },
    { key: 'amber', label: 'AMBER – Watch', value: String(r.amber), risk: 'AMBER' },
    { key: 'green', label: 'GREEN – Routine', value: String(r.green), risk: 'GREEN' },
  ];
}

/** Column totals of the village table. */
export function villageTotals(villages: readonly CensusVillageOut[]) {
  return villages.reduce(
    (acc, v) => ({
      pregnant: acc.pregnant + v.pregnant,
      bpl: acc.bpl + v.bpl,
      red: acc.red + v.red,
      amber: acc.amber + v.amber,
      green: acc.green + v.green,
      due_this_month: acc.due_this_month + v.due_this_month,
    }),
    { pregnant: 0, bpl: 0, red: 0, amber: 0, green: 0, due_this_month: 0 },
  );
}

export type LatLngPair = [number, number];

/** Fallback map centre (Dankaur block, synthetic seed) when no village has coordinates. */
export const DEFAULT_MAP_CENTER: LatLngPair = [28.35, 77.55];

/**
 * `[[south, west], [north, east]]` around the villages with finite coordinates, or
 * null when there are none. The census has no facility coordinates, so the map is
 * framed on the facility's villages.
 */
export function villageBounds(villages: readonly Pick<CensusVillageOut, 'lat' | 'lng'>[]): [LatLngPair, LatLngPair] | null {
  const pts = villages.filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
  if (pts.length === 0) return null;
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const p of pts) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
  }
  return [
    [s, w],
    [n, e],
  ];
}
