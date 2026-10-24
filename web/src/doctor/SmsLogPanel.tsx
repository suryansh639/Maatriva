/**
 * Mock SMS log panel for the dashboard panels slot (Req 17.4, 25.4). English only.
 *
 * Loads `GET /api/notifications?limit=50` (newest first, facility-scoped by the
 * server) and shows each row's time, kind, recipient (username and role), body
 * and its `mock_sent` status. Nothing here is ever sent: the panel is labelled
 * "Mock SMS – not sent".
 *
 * Refetches:
 * - whenever `refetchTick` changes (doctor: each SSE `hello`; ANM: every 30 s)
 * - on live events that write SMS rows (`alert.created`, `alert.updated`,
 *   `task.done`), debounced 300 ms and coalesced
 * - on the Refresh button (task creation and digest sends have no live event)
 *
 * The last good rows stay visible while refetching or after an error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../shared/api';
import { formatIstHHMM, istDate, parseIsoZ } from '../shared/time';
import type { NotificationKind, NotificationOut, Role } from '../shared/types';
import { listNotifications } from './doctorApi';
import type { LiveEvent, LiveEventsState } from './live/useLiveEvents';
import './panels.css';

/** Rows shown (Req 25.4). */
export const SMS_LOG_LIMIT = 50;
export const SMS_LOG_REFETCH_DEBOUNCE_MS = 300;
export const SMS_LOG_LABEL = 'Mock SMS – not sent';

export const SMS_KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  red_alert: 'RED alert',
  task_assigned: 'Task assigned',
  amber_digest: 'AMBER digest',
  task_done: 'Task done',
};

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  asha: 'ASHA',
  anm: 'ANM',
  doctor: 'Doctor',
  admin: 'Admin',
};

/** Live events after which the server has written new SMS rows. */
export function shouldRefetchSmsLog(ev: Pick<LiveEvent, 'type'>): boolean {
  return ev.type === 'alert.created' || ev.type === 'alert.updated' || ev.type === 'task.done';
}

/** "username (Role)", falling back to the role or "Unknown recipient". */
export function smsRecipientLabel(row: Pick<NotificationOut, 'to_username' | 'to_role'>): string {
  const role = row.to_role ? ROLE_LABELS[row.to_role] ?? row.to_role : null;
  if (row.to_username && role) return `${row.to_username} (${role})`;
  return row.to_username ?? role ?? 'Unknown recipient';
}

function formatTime(iso: string): string {
  const ms = parseIsoZ(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${istDate(ms)} ${formatIstHHMM(ms)} IST`;
}

export function SmsLogView({ rows }: { rows: readonly NotificationOut[] }) {
  if (rows.length === 0) {
    return <p className="panel__empty">No mock SMS yet.</p>;
  }
  return (
    <div className="sms-log__scroll">
      <table className="sms-log__table">
        <caption>
          {SMS_LOG_LABEL}: the latest {SMS_LOG_LIMIT} messages, newest first. Nothing is sent to any phone.
        </caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Kind</th>
            <th scope="col">To</th>
            <th scope="col">Message</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id} data-kind={n.kind}>
              <td className="sms-log__time">{formatTime(n.created_at)}</td>
              <td>{SMS_KIND_LABELS[n.kind] ?? n.kind}</td>
              <td>{smsRecipientLabel(n)}</td>
              <td className="sms-log__body">{n.body}</td>
              <td>
                <span className="sms-log__status">{n.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface SmsLogPanelProps {
  /** Any change refetches the log. */
  refetchTick?: number;
  /** Shared live stream; SMS-writing events refetch the log. */
  subscribe?: LiveEventsState['subscribe'];
}

export function SmsLogPanel({ refetchTick = 0, subscribe }: SmsLogPanelProps) {
  const [rows, setRows] = useState<NotificationOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    listNotifications(SMS_LOG_LIMIT, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(isApiError(err) ? err.message : 'Check the connection.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [refetchTick, version]);

  // Debounced, coalesced refetch on SMS-writing live events.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!subscribe) return;
    const unsubscribe = subscribe((ev) => {
      if (!shouldRefetchSmsLog(ev)) return;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        reload();
      }, SMS_LOG_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [subscribe, reload]);

  return (
    <section className="panel sms-log" aria-labelledby="sms-log-heading" aria-busy={loading}>
      <div className="panel__head">
        <h2 id="sms-log-heading">Mock SMS log (not sent)</h2>
        <span className="sms-log__badge">{SMS_LOG_LABEL}</span>
        <button type="button" className="btn" onClick={reload} aria-label="Refresh the mock SMS log">
          Refresh
        </button>
      </div>
      {rows ? <SmsLogView rows={rows} /> : loading ? <p role="status">Loading mock SMS…</p> : null}
      {error ? (
        <div role="alert">
          <p className="form-error">Could not load the SMS log: {error}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default SmsLogPanel;
