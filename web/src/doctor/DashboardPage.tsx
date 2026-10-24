/**
 * Doctor / ANM dashboard overview (Req 19.5, 19.8, 19.9, 20.2–20.5, 21.4, 21.5, 38.4;
 * design §15.5, §17). English only.
 *
 * DOM and tab order (Req 38.4):
 * 1. Live status line (text only, `aria-live="polite"`)
 * 2. `CensusHeader`: KPI cards (no focusable elements)
 * 3. Village overview: `VillageTable` (its village buttons are the village filter)
 *    beside `VillageMap` (no keyboard stop except the OSM attribution link)
 * 4. `TriageQueue`: village and risk filters, then the rows
 * 5. Panels: `OutcomesPanel`, then `SmsLogPanel`
 *
 * The village filter lives here so the table, the map and the queue share it.
 *
 * Live updates (see `dashboardLive.ts` for the event → refetch table): doctors get
 * SSE events, ANMs a 30 s `refetchTick`. Refetches are debounced 300 ms and
 * coalesced. A RED `alert.created` moves the mother's row to the top straight away.
 *
 * Pass the layout's `useLiveEvents()` result as `live` to share one stream. The
 * layout then owns the RED toast and the live status line. Without `live` the page
 * mounts its own hook and shows both itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../shared/api';
import type { CensusOut, RiskLevel } from '../shared/types';
import { CensusHeader } from './CensusHeader';
import {
  ALL_TARGETS,
  alertIdsKey,
  createRefetchScheduler,
  liveStatusText,
  promoteAlertInQueue,
  refetchTargetsFor,
} from './dashboardLive';
import type { RefetchTarget } from './dashboardLive';
import { getCensus } from './doctorApi';
import { useLiveEvents } from './live/useLiveEvents';
import type { LiveEventsState } from './live/useLiveEvents';
import { OutcomesPanel } from './OutcomesPanel';
import { SmsLogPanel } from './SmsLogPanel';
import { TriageQueue, useQueue } from './TriageQueue';
import { useRedAlertToasts } from './useRedAlertToasts';
import { VillageMap } from './VillageMap';
import { VillageTable } from './VillageTable';
import './dashboard.css';

export interface CensusState {
  census: CensusOut | null;
  error: string | null;
  loading: boolean;
  /** Refetch the census (live events, ANM interval, Retry). Aborts a fetch in flight. */
  reload: () => void;
}

/** Load `GET /api/dashboard/census`; keeps the last good census while refetching. */
export function useCensus(): CensusState {
  const [census, setCensus] = useState<CensusOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ctrlRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    getCensus(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setCensus(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(isApiError(err) ? err.message : 'Could not load the census. Check the connection.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
    return () => ctrlRef.current?.abort();
  }, [reload]);

  return { census, error, loading, reload };
}

export type DashboardLive = Pick<LiveEventsState, 'mode' | 'status' | 'subscribe' | 'refetchTick' | 'openAlerts'>;

export interface DashboardPageProps {
  /** Shared live connection from the doctor layout; when absent the page opens its own. */
  live?: DashboardLive;
}

export default function DashboardPage({ live }: DashboardPageProps) {
  return live ? <DashboardView live={live} showLiveStatus={false} /> : <DashboardOwnLive />;
}

function DashboardOwnLive() {
  const live = useLiveEvents();
  useRedAlertToasts(live.subscribe);
  return <DashboardView live={live} showLiveStatus />;
}

function DashboardView({ live, showLiveStatus }: { live: DashboardLive; showLiveStatus: boolean }) {
  const { census, error, loading, reload: reloadCensus } = useCensus();
  // Shared village filter: set by the table, the map and the queue's select.
  const [villageFilter, setVillageFilter] = useState<string | null>(null);
  const [riskFilter, setRiskFilter] = useState<RiskLevel | null>(null);
  const queue = useQueue(villageFilter, riskFilter);
  const { reload: reloadQueue, setRows: setQueueRows } = queue;

  // Drop a filter whose village is no longer in the census.
  useEffect(() => {
    if (census && villageFilter && !census.villages.some((v) => v.id === villageFilter)) {
      setVillageFilter(null);
    }
  }, [census, villageFilter]);

  // Debounced, coalesced refetches. The refs keep the scheduler stable while the
  // reload functions change with the filters.
  const reloadQueueRef = useRef(reloadQueue);
  const reloadCensusRef = useRef(reloadCensus);
  reloadQueueRef.current = reloadQueue;
  reloadCensusRef.current = reloadCensus;
  const scheduler = useMemo(
    () =>
      createRefetchScheduler((targets: ReadonlySet<RefetchTarget>) => {
        if (targets.has('queue')) reloadQueueRef.current();
        if (targets.has('census')) reloadCensusRef.current();
      }),
    [],
  );
  useEffect(() => () => scheduler.cancel(), [scheduler]);

  // Live events → optimistic queue update and refetch (toasts: useRedAlertToasts).
  const { subscribe, refetchTick, openAlerts } = live;
  useEffect(
    () =>
      subscribe((ev) => {
        if (ev.type === 'alert.created' && ev.data.alert?.severity === 'RED') {
          const { alert } = ev.data;
          setQueueRows((rows) => promoteAlertInQueue(rows, alert));
        }
        scheduler.schedule(refetchTargetsFor(ev));
      }),
    [subscribe, setQueueRows, scheduler],
  );

  // Every refetch tick (doctor: each SSE `hello`; ANM: every 30 s) refetches everything.
  const lastTick = useRef(refetchTick);
  useEffect(() => {
    if (refetchTick === lastTick.current) return;
    lastTick.current = refetchTick;
    scheduler.schedule(ALL_TARGETS);
  }, [refetchTick, scheduler]);

  // Alerts found by the 15 s poll while disconnected: refetch when the set changes.
  const openAlertsKey = openAlerts ? alertIdsKey(openAlerts) : null;
  const lastAlertsKey = useRef<string | null>(null);
  useEffect(() => {
    if (openAlertsKey == null) return;
    const prev = lastAlertsKey.current;
    lastAlertsKey.current = openAlertsKey;
    if (prev != null && prev !== openAlertsKey) scheduler.schedule(ALL_TARGETS);
  }, [openAlertsKey, scheduler]);

  const statusText = liveStatusText(live);

  return (
    <div className="dashboard">
      {showLiveStatus ? (
        <p
          className="dashboard__live"
          role="status"
          aria-live="polite"
          data-live-status={live.mode === 'sse' ? live.status : live.mode}
        >
          {statusText ? (
            <>
              <span className="dashboard__live-dot" aria-hidden="true" />
              {statusText}
            </>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <div className="dashboard__error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={reloadCensus}>
            Retry
          </button>
        </div>
      ) : null}

      {census ? (
        <>
          <CensusHeader census={census} />

          <section className="dashboard__villages" aria-labelledby="villages-heading">
            <h2 id="villages-heading">Villages</h2>
            <div className="dashboard__villages-grid">
              <VillageTable
                villages={census.villages}
                selectedVillageId={villageFilter}
                onSelectVillage={setVillageFilter}
              />
              <VillageMap
                villages={census.villages}
                selectedVillageId={villageFilter}
                onSelectVillage={setVillageFilter}
              />
            </div>
          </section>
        </>
      ) : loading ? (
        <p className="page-loading" role="status">
          Loading census…
        </p>
      ) : null}

      <section className="dashboard__queue" aria-labelledby="queue-heading" data-village-filter={villageFilter ?? ''}>
        <h2 id="queue-heading">Triage queue</h2>
        <TriageQueue
          queue={queue}
          villages={census?.villages ?? []}
          villageId={villageFilter}
          onVillageChange={setVillageFilter}
          risk={riskFilter}
          onRiskChange={setRiskFilter}
        />
      </section>

      <div className="dashboard__panels">
        <OutcomesPanel refetchTick={refetchTick} />
        <SmsLogPanel refetchTick={refetchTick} subscribe={subscribe} />
      </div>
    </div>
  );
}
