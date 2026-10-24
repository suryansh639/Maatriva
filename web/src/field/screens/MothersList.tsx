/**
 * Field mothers list (Req 26.4, 29.3, 29.4, 29.5).
 *
 * Reads local Dexie data only, so it works offline. Each row shows the name (a
 * link to the mother detail), guardian, village, GA "{w}w {d}d", a BPL tag, the
 * risk chip (icon + word + colour; "Risk: pending sync" before the first pull),
 * a "Not synced yet" marker while she or her visits are queued, and the "Demo"
 * tag for the seeded demo mother.
 *
 * Order and search come from `mothersList.ts`: RED, AMBER, pending, GREEN, then
 * name, with the demo mother first in `asha1`'s list.
 *
 * E2E hooks: the search box is `data-testid="mother-search"`, each row is
 * `data-testid="mother-row"` with `data-mother-id`, and the name link's
 * accessible name is the mother's full name (e.g. "Sunita Demo (synthetic)").
 */
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '../../shared/auth';
import { gaDays, gaLabel } from '../../shared/gestation';
import { useI18n } from '../../shared/I18nProvider';
import { RiskChip } from '../../shared/RiskChip';
import { todayIST } from '../../shared/time';
import type { LocalMother, VillageOut } from '../../shared/types';
import type { FieldDb } from '../db';
import { isDemoMother, searchMothers, sortMothers } from '../mothersList';
import { motherPath } from '../paths';
import { useSync } from '../sync/SyncProvider';
import './mothers.css';

const EMPTY_MOTHERS: LocalMother[] = [];
const EMPTY_VILLAGES: VillageOut[] = [];

/**
 * Ids of mothers with queued local changes: her own upsert or a new visit.
 * Live, so the marker disappears once the outbox entry is pushed.
 */
export function usePendingMotherIds(db: FieldDb): ReadonlySet<string> {
  return useLiveQuery(
    async () => {
      const ids = new Set<string>();
      await db.outbox.each((e) => {
        if (e.entity === 'mother') ids.add(e.entity_id);
        else if (e.entity === 'visit') ids.add(e.data.mother_id.toLowerCase());
      });
      return ids;
    },
    [db],
    new Set<string>(),
  );
}

/** Village id → name map from the local villages table. */
export function useVillageNames(db: FieldDb): ReadonlyMap<string, string> {
  const villages = useLiveQuery(() => db.villages.toArray(), [db], EMPTY_VILLAGES);
  return useMemo(() => new Map(villages.map((v) => [v.id, v.name])), [villages]);
}

/** GA today as "{w}w {d}d", or null for an unparseable LMP. */
export function gaToday(lmp: string): string | null {
  try {
    return gaLabel(gaDays(lmp, todayIST()));
  } catch {
    return null;
  }
}

export function MothersList() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { db } = useSync();
  const searchId = useId();
  const [query, setQuery] = useState('');

  const mothers = useLiveQuery(() => db.mothers.toArray(), [db]);
  const villages = useVillageNames(db);
  const pendingIds = usePendingMotherIds(db);

  const rows = useMemo(
    () => sortMothers(searchMothers(mothers ?? EMPTY_MOTHERS, query, villages), { username: user?.username }),
    [mothers, query, villages, user?.username],
  );

  const loading = mothers === undefined;
  const total = mothers?.length ?? 0;
  const q = query.trim();

  return (
    <section className="field-screen mothers-list" aria-labelledby="mothers-title">
      <h1 id="mothers-title">{t('field.mothers.title')}</h1>

      <div className="form-field">
        <label htmlFor={searchId}>{t('field.mothers.searchLabel')}</label>
        <input
          id={searchId}
          type="search"
          autoComplete="off"
          data-testid="mother-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <p className="mothers-list__count" role="status" aria-live="polite">
        {loading
          ? t('field.common.loading')
          : total === 0
            ? t('field.mothers.empty')
            : rows.length === 0
              ? t('field.mothers.noResults', { q })
              : t('field.mothers.count', { n: rows.length })}
      </p>

      {rows.length > 0 ? (
        <ul className="mother-cards" aria-labelledby="mothers-title">
          {rows.map((m) => {
            const ga = gaToday(m.lmp_date);
            const village = villages.get(m.village_id) ?? '';
            const pending = Boolean(m.pending) || pendingIds.has(m.id);
            return (
              <li key={m.id} className="mother-card" data-testid="mother-row" data-mother-id={m.id}>
                <div className="mother-card__top">
                  <Link to={motherPath(m.id)} className="mother-card__name">
                    {m.full_name}
                  </Link>
                  <RiskChip level={m.risk_level} />
                </div>
                <p className="mother-card__line">{t('field.mothers.guardian', { name: m.guardian_name })}</p>
                <p className="mother-card__line">
                  {village ? <span>{village}</span> : null}
                  {village && ga ? <span aria-hidden="true"> · </span> : null}
                  {ga ? <span>{t('field.mothers.ga', { ga })}</span> : null}
                </p>
                <p className="mother-card__tags">
                  {isDemoMother(m) ? (
                    <span className="tag tag--demo" data-testid="demo-tag">
                      {t('field.common.demoTag')}
                    </span>
                  ) : null}
                  {m.is_bpl ? <span className="tag tag--bpl">{t('field.common.bplTag')}</span> : null}
                  {pending ? (
                    <span className="tag tag--pending" data-testid="pending-marker">
                      <span aria-hidden="true">⟳ </span>
                      {t('field.common.pendingMarker')}
                    </span>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default MothersList;
