/**
 * Pure helpers for the field mothers list (Req 29.4, 29.5; design §16 "Screens").
 *
 * - `sortMothers`: rank RED 0, AMBER 1, pending 2 (never pulled, so `risk_level` is
 *   null), GREEN 3; then `full_name` with `localeCompare`, then id for a stable order.
 *   The demo mother gets rank −1 (listed first) in `asha1`'s list.
 * - `searchMothers`: case-insensitive substring match on name, guardian, village
 *   name or Short_Code.
 */

import type { RiskLevel } from '../shared/types';

/** The seeded demo mother (design §13). */
export const DEMO_MOTHER_ID = '00000000-0000-4000-8000-000000000001';
/** The ASHA whose list shows the demo mother first (Req 29.5). */
export const DEMO_ASHA_USERNAME = 'asha1';

/** The fields the list helpers read; `LocalMother` satisfies it. */
export interface MotherListRow {
  id: string;
  full_name: string;
  guardian_name: string;
  village_id: string;
  risk_level: RiskLevel | null;
}

/** Village id → name, for search and display. */
export type VillageNames = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

/** Short_Code: first 6 hex characters of the mother UUID, uppercased (backend `short_code`). */
export function shortCode(motherId: string): string {
  return motherId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

export function isDemoMother(row: Pick<MotherListRow, 'id'>): boolean {
  return row.id.toLowerCase() === DEMO_MOTHER_ID;
}

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { RED: 0, AMBER: 1, GREEN: 3 };
const PENDING_RANK = 2;
const DEMO_RANK = -1;

export interface SortOptions {
  /** Signed-in username; the demo mother is ranked first for `asha1`. */
  username?: string | null;
}

/** Sort rank of one row (lower first). */
export function motherRank(row: MotherListRow, opts: SortOptions = {}): number {
  if (opts.username === DEMO_ASHA_USERNAME && isDemoMother(row)) return DEMO_RANK;
  return row.risk_level === null ? PENDING_RANK : RISK_RANK[row.risk_level] ?? PENDING_RANK;
}

/** A new array sorted for display; the input is not modified. */
export function sortMothers<T extends MotherListRow>(rows: readonly T[], opts: SortOptions = {}): T[] {
  return rows
    .map((row) => ({ row, rank: motherRank(row, opts) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.row.full_name.localeCompare(b.row.full_name) ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
    )
    .map((x) => x.row);
}

function villageName(villages: VillageNames | undefined, id: string): string {
  if (!villages) return '';
  if (villages instanceof Map) return villages.get(id) ?? '';
  return Object.hasOwn(villages, id) ? (villages as Readonly<Record<string, string>>)[id] : '';
}

/**
 * Rows whose name, guardian, village name or Short_Code contains `query`
 * (trimmed, case-insensitive). A blank query returns all rows, in input order.
 */
export function searchMothers<T extends MotherListRow>(
  rows: readonly T[],
  query: string,
  villages?: VillageNames,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter((row) =>
    [row.full_name, row.guardian_name, villageName(villages, row.village_id), shortCode(row.id)].some((s) =>
      s.toLowerCase().includes(q),
    ),
  );
}
