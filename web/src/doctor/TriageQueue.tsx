/**
 * Triage queue (Req 21.4, 21.5, 38.4; design §15.5). English only.
 *
 * - `useQueue(filters)` loads `GET /api/dashboard/queue?village_id=&risk=` and keeps
 *   the last good rows while refetching. The server sorts RED → AMBER → GREEN, then
 *   by `risk_updated_at` descending; the list is shown in that order.
 * - `TriageQueue` renders the village and risk filters (labelled selects), then a
 *   semantic table. Each row has the risk chip (icon + word + colour), the name
 *   (a link to the patient), BPL tag, village, GA, EDD, top reason, last visit,
 *   alert status ("Resolved since alert" when no longer RED), open task count and
 *   an "Open" button. Tab order: filters, then the rows (Req 38.4).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isApiError } from '../shared/api';
import { gaLabel } from '../shared/gestation';
import { RiskChip } from '../shared/RiskChip';
import { AREA_PATHS } from '../shared/routes';
import type { AlertStatus, CensusVillageOut, QueueRowOut, RiskLevel } from '../shared/types';
import { isResolvedSinceAlert, topReason } from './dashboardLive';
import { getQueue } from './doctorApi';

export interface QueueState {
  rows: readonly QueueRowOut[] | null;
  error: string | null;
  loading: boolean;
  /** Refetch now; aborts a fetch in flight. */
  reload: () => void;
  /** Local (optimistic) update of the shown rows; the next reload replaces it. */
  setRows: (update: (rows: readonly QueueRowOut[]) => readonly QueueRowOut[]) => void;
}

/** Loads the queue for the given filters; refetches when they change. */
export function useQueue(villageId: string | null, risk: RiskLevel | null): QueueState {
  const [rows, setRowsState] = useState<readonly QueueRowOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ctrlRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    getQueue({ village_id: villageId, risk }, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setRowsState(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(isApiError(err) ? err.message : 'Could not load the triage queue. Check the connection.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
  }, [villageId, risk]);

  useEffect(() => {
    reload();
    return () => ctrlRef.current?.abort();
  }, [reload]);

  const setRows = useCallback((update: (rows: readonly QueueRowOut[]) => readonly QueueRowOut[]) => {
    setRowsState((current) => (current ? update(current) : current));
  }, []);

  return { rows, error, loading, reload, setRows };
}

const RISK_OPTIONS: readonly { value: RiskLevel; label: string }[] = [
  { value: 'RED', label: 'RED – High' },
  { value: 'AMBER', label: 'AMBER – Watch' },
  { value: 'GREEN', label: 'GREEN – Routine' },
];

const ALERT_STATUS_LABELS: Readonly<Record<AlertStatus, string>> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  actioned: 'Actioned',
  closed: 'Closed',
};

function isRiskLevel(value: string): value is RiskLevel {
  return value === 'RED' || value === 'AMBER' || value === 'GREEN';
}

export function patientPath(motherId: string): string {
  return `${AREA_PATHS.doctor}/mother/${encodeURIComponent(motherId)}`;
}

export interface TriageQueueProps {
  queue: Pick<QueueState, 'rows' | 'error' | 'loading' | 'reload'>;
  /** Villages for the village filter (from the census). */
  villages: readonly Pick<CensusVillageOut, 'id' | 'name'>[];
  villageId: string | null;
  onVillageChange: (villageId: string | null) => void;
  risk: RiskLevel | null;
  onRiskChange: (risk: RiskLevel | null) => void;
}

export function TriageQueue({ queue, villages, villageId, onVillageChange, risk, onRiskChange }: TriageQueueProps) {
  const navigate = useNavigate();
  const { rows, error, loading, reload } = queue;
  const filtered = villageId != null || risk != null;
  const villageName = villages.find((v) => v.id === villageId)?.name ?? null;

  return (
    <div className="triage-queue" aria-busy={loading}>
      <div className="triage-queue__filters" role="group" aria-label="Queue filters">
        <label className="triage-queue__filter">
          <span>Village</span>
          <select value={villageId ?? ''} onChange={(e) => onVillageChange(e.target.value || null)}>
            <option value="">All villages</option>
            {villages.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="triage-queue__filter">
          <span>Risk</span>
          <select
            value={risk ?? ''}
            onChange={(e) => onRiskChange(isRiskLevel(e.target.value) ? e.target.value : null)}
          >
            <option value="">All risk levels</option>
            {RISK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {filtered ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              onVillageChange(null);
              onRiskChange(null);
            }}
          >
            Clear filters
          </button>
        ) : null}
        <p className="triage-queue__count" role="status">
          {rows ? `${rows.length} ${rows.length === 1 ? 'mother' : 'mothers'}` : ''}
          {loading && rows ? ' · Refreshing…' : ''}
        </p>
      </div>

      {error ? (
        <div className="dashboard__error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}

      {rows == null ? (
        loading ? (
          <p className="page-loading" role="status">
            Loading triage queue…
          </p>
        ) : null
      ) : rows.length === 0 ? (
        <p className="dashboard__placeholder">
          {filtered ? 'No mothers match these filters.' : 'No active pregnancies in this facility.'}
        </p>
      ) : (
        <div className="triage-queue__scroll">
          <table className="triage-queue__table">
            <caption>
              Active mothers, highest risk first (RED, then AMBER, then GREEN; most recently changed first).
              {villageName ? ` Village: ${villageName}.` : ''}
              {risk ? ` Risk: ${risk}.` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Risk</th>
                <th scope="col">Name</th>
                <th scope="col">Village</th>
                <th scope="col">GA</th>
                <th scope="col">EDD</th>
                <th scope="col">Top reason</th>
                <th scope="col">Last visit</th>
                <th scope="col">Alert</th>
                <th scope="col">Open tasks</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <QueueRow key={row.mother_id} row={row} onOpen={() => navigate(patientPath(row.mother_id))} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QueueRow({ row, onOpen }: { row: QueueRowOut; onOpen: () => void }) {
  const reason = topReason(row);
  const extraFlags = Math.max(row.flags.length - 1, 0);
  const resolved = isResolvedSinceAlert(row);
  return (
    <tr className="triage-queue__row" data-risk={row.risk_level} data-mother-id={row.mother_id}>
      <td>
        <RiskChip level={row.risk_level} />
      </td>
      <th scope="row" className="triage-queue__name">
        <Link to={patientPath(row.mother_id)}>{row.full_name}</Link>
        <span className="triage-queue__guardian">
          <span className="visually-hidden">Guardian: </span>
          {row.guardian_name}
        </span>
        {row.is_bpl ? <span className="triage-queue__tag">BPL</span> : null}
      </th>
      <td>{row.village_name}</td>
      <td>{gaLabel(row.ga_days)}</td>
      <td>{row.edd_date}</td>
      <td className="triage-queue__reason">
        {reason ?? <span className="triage-queue__muted">No active flags</span>}
        {extraFlags > 0 ? <span className="triage-queue__muted"> (+{extraFlags} more)</span> : null}
      </td>
      <td>{row.last_visit_date ?? <span className="triage-queue__muted">No visits</span>}</td>
      <td>
        {row.open_alert_status ? (
          <span className="triage-queue__alert" data-alert-status={row.open_alert_status}>
            {ALERT_STATUS_LABELS[row.open_alert_status]}
          </span>
        ) : (
          <span className="triage-queue__muted">–</span>
        )}
        {resolved ? <span className="triage-queue__tag triage-queue__tag--resolved">Resolved since alert</span> : null}
      </td>
      <td>{row.open_task_count}</td>
      <td>
        <button type="button" className="btn" onClick={onOpen} aria-label={`Open ${row.full_name}`}>
          Open
        </button>
      </td>
    </tr>
  );
}

export default TriageQueue;
