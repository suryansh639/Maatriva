/**
 * Patient detail page, `/doctor/mother/:id` (Req 19.9, 22.2–22.8, 37.8). English only.
 *
 * - Loads `GET /api/mothers/{id}` (the id comes from the route, or the `motherId` prop).
 * - Header: name, village, ASHA, GA, EDD, BPL and the risk chip; then the active
 *   flags with their reasons.
 * - Alerts with an "Acknowledge" button on `open` alerts, for doctors only.
 * - `renderActions` is the doctor actions slot; it receives the detail, `today`,
 *   `isDoctor` and `reload`, and defaults to ActionForm + BirthOutcomeForm
 *   (doctors only, so ANMs see no forms).
 * - Closed-loop timeline ("Loop closed"), tasks, then the charts.
 *
 * Live refresh (design §17 table): `alert.created`, `alert.updated`, `risk.changed`
 * and `task.done` events for this mother refetch the detail, debounced 300 ms and
 * coalesced. Every `refetchTick` change (doctor: each SSE `hello`, so missed events
 * are recovered; ANM: every 30 s) refetches too. Pass the layout's `useLiveEvents()`
 * result as `live` to share one stream; without it the page mounts its own hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../shared/api';
import { useAuth } from '../shared/auth';
import { gaLabel } from '../shared/gestation';
import { actionLabel, flagLabel } from '../shared/i18n';
import { RiskChip } from '../shared/RiskChip';
import { AREA_PATHS } from '../shared/routes';
import { formatIstHHMM, istDate, parseIsoZ, todayIST } from '../shared/time';
import type { AlertOut, MotherDetailOut, TaskOut } from '../shared/types';
import { ActionForm } from './ActionForm';
import { BirthOutcomeForm } from './BirthOutcomeForm';
import { ackAlert, getMotherDetail } from './doctorApi';
import { useLiveEvents } from './live/useLiveEvents';
import type { LiveEventsState } from './live/useLiveEvents';
import { shouldRefetchDetail } from './patientChartData';
import { BpChart, HbChart, SupplementsChart, WeightGainChart } from './PatientCharts';
import { isTaskOverdue } from './timeline';
// `Timeline.tsx` and `timeline.ts` differ only in case, so an extensionless
// `./Timeline` resolves to `timeline.ts` on Windows. The `.jsx` specifier makes
// TypeScript and Vite pick `Timeline.tsx`.
import { PatientTimeline } from './Timeline.jsx';
import './patientDetail.css';

/** Live refetches are debounced and coalesced (design §17). */
export const DETAIL_REFETCH_DEBOUNCE_MS = 300;

export interface PatientActionsContext {
  detail: MotherDetailOut;
  /** IST date today ("YYYY-MM-DD"). */
  today: string;
  /** Doctors may act; ANMs are read-only (Req 37.8). */
  isDoctor: boolean;
  /** Refetch the detail now (e.g. after a task or outcome is created). */
  reload: () => void;
}

export interface PatientDetailProps {
  /** Overrides the `:id` route parameter. */
  motherId?: string;
  /** Shared live connection from the doctor layout; when absent the page opens its own. */
  live?: Pick<LiveEventsState, 'subscribe' | 'refetchTick'>;
  /** Doctor actions slot; defaults to `defaultPatientActions` (ActionForm + BirthOutcomeForm). */
  renderActions?: (ctx: PatientActionsContext) => ReactNode;
}

/**
 * Default actions: ActionForm and BirthOutcomeForm, doctors only (Req 23.9, 24.5,
 * 37.8). ANMs get nothing, so the actions section is not rendered for them.
 */
export function defaultPatientActions(ctx: PatientActionsContext): ReactNode {
  if (!ctx.isDoctor) return null;
  return (
    <>
      <ActionForm detail={ctx.detail} today={ctx.today} isDoctor={ctx.isDoctor} reload={ctx.reload} />
      <BirthOutcomeForm detail={ctx.detail} today={ctx.today} isDoctor={ctx.isDoctor} reload={ctx.reload} />
    </>
  );
}

type LiveProp = NonNullable<PatientDetailProps['live']>;

function formatDateTime(iso: string | null): string {
  if (!iso) return '–';
  const ms = parseIsoZ(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${istDate(ms)} ${formatIstHHMM(ms)} IST`;
}

function shortCode(id: string): string {
  return id.replace(/-/g, '').slice(0, 6).toUpperCase();
}

const ALERT_STATUS_LABELS: Readonly<Record<AlertOut['status'], string>> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  actioned: 'Actioned',
  closed: 'Closed',
};

const TASK_STATUS_LABELS: Readonly<Record<TaskOut['status'], string>> = {
  open: 'open',
  done: 'done',
  cancelled: 'cancelled',
};

export function PatientDetail({ live, ...rest }: PatientDetailProps) {
  return live ? <PatientDetailView live={live} {...rest} /> : <PatientDetailOwnLive {...rest} />;
}

function PatientDetailOwnLive(props: Omit<PatientDetailProps, 'live'>) {
  const live = useLiveEvents();
  return <PatientDetailView live={live} {...props} />;
}

function PatientDetailView({
  motherId: motherIdProp,
  live,
  renderActions = defaultPatientActions,
}: PatientDetailProps & { live: LiveProp }) {
  const params = useParams<{ id: string }>();
  const motherId = (motherIdProp ?? params.id ?? '').toLowerCase();
  const { user } = useAuth();
  const isDoctor = user?.role === 'doctor';

  const [detail, setDetail] = useState<MotherDetailOut | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [ackMessage, setAckMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Fetch on mount, on id change and on every reload.
  useEffect(() => {
    if (!motherId) return;
    const ctrl = new AbortController();
    setLoading(true);
    getMotherDetail(motherId, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setDetail(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [motherId, version]);

  // Debounced, coalesced live refetch.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleReload = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      reload();
    }, DETAIL_REFETCH_DEBOUNCE_MS);
  }, [reload]);
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  const { subscribe, refetchTick } = live;
  useEffect(() => {
    if (!motherId) return;
    return subscribe((ev) => {
      if (shouldRefetchDetail(ev, motherId)) scheduleReload();
    });
  }, [subscribe, motherId, scheduleReload]);

  const lastTick = useRef(refetchTick);
  useEffect(() => {
    if (refetchTick === lastTick.current) return;
    lastTick.current = refetchTick;
    scheduleReload();
  }, [refetchTick, scheduleReload]);

  const onAcknowledge = useCallback(
    async (alertId: string) => {
      setAckBusy(alertId);
      setAckMessage(null);
      try {
        await ackAlert(alertId);
        setAckMessage({ tone: 'ok', text: 'Alert acknowledged.' });
        reload();
      } catch (err) {
        if (isApiError(err) && err.code === 'INVALID_STATE') {
          setAckMessage({ tone: 'error', text: 'This alert is no longer open. Refreshing.' });
          reload();
        } else {
          setAckMessage({
            tone: 'error',
            text: isApiError(err) ? `Could not acknowledge: ${err.message}` : 'Could not acknowledge – try again.',
          });
        }
      } finally {
        setAckBusy(null);
      }
    },
    [reload],
  );

  const shown = detail && detail.mother.id.toLowerCase() === motherId ? detail : null;
  const backLink = (
    <p className="pd-back">
      <Link to={AREA_PATHS.doctor}>← Back to dashboard</Link>
    </p>
  );

  if (!motherId) {
    return (
      <div className="patient-detail">
        {backLink}
        <p className="form-error">No patient selected.</p>
      </div>
    );
  }

  if (!shown) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <div className="patient-detail">
        {backLink}
        {loading ? (
          <p role="status">Loading patient…</p>
        ) : notFound ? (
          <p className="form-error" role="alert">
            Patient not found, or not in your facility.
          </p>
        ) : error ? (
          <div role="alert">
            <p className="form-error">
              Could not load the patient{isApiError(error) ? `: ${error.message}` : ' – check your connection'}.
            </p>
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const { mother, village, asha, visits, flags_active: flags, alerts, tasks, birth_outcome } = shown;
  const today = todayIST();
  const actions = renderActions({ detail: shown, today, isDoctor, reload });
  const sortedAlerts = [...alerts].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const sortedTasks = [...tasks].sort((a, b) => {
    const rank = (t: TaskOut) => (t.status === 'open' ? 0 : t.status === 'done' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });

  return (
    <article className="patient-detail" aria-labelledby="pd-name" aria-busy={loading}>
      {backLink}

      <header className="pd-header">
        <div className="pd-header__title">
          <h1 id="pd-name">{mother.full_name}</h1>
          <RiskChip level={mother.risk_level} />
          {mother.status === 'delivered' ? <span className="pd-tag">Delivered</span> : null}
        </div>
        <dl className="pd-facts">
          <div>
            <dt>ID</dt>
            <dd>{shortCode(mother.id)}</dd>
          </div>
          <div>
            <dt>Guardian</dt>
            <dd>{mother.guardian_name}</dd>
          </div>
          <div>
            <dt>Age</dt>
            <dd>{mother.age}</dd>
          </div>
          <div>
            <dt>Village</dt>
            <dd>{village.name}</dd>
          </div>
          <div>
            <dt>ASHA</dt>
            <dd>{asha.full_name}</dd>
          </div>
          <div>
            <dt>GA</dt>
            <dd>{gaLabel(shown.ga_days)}</dd>
          </div>
          <div>
            <dt>EDD</dt>
            <dd>{mother.edd_date}</dd>
          </div>
          <div>
            <dt>BPL</dt>
            <dd>{mother.is_bpl ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Height</dt>
            <dd>{mother.height_cm != null ? `${mother.height_cm} cm` : 'Unknown'}</dd>
          </div>
        </dl>
        {loading ? (
          <p className="pd-refreshing" role="status">
            Refreshing…
          </p>
        ) : null}
      </header>

      <section className="pd-section" aria-labelledby="pd-flags-heading">
        <h2 id="pd-flags-heading">Active risk flags</h2>
        {flags.length === 0 ? (
          <p className="pd-empty">No active risk flags.</p>
        ) : (
          <ul className="pd-flags">
            {flags.map((f) => (
              <li key={f.code} className="pd-flag">
                <RiskChip level={f.severity === 'RED' ? 'RED' : 'AMBER'} />
                <span className="pd-flag__text">
                  <strong>{flagLabel('en', f.code)}</strong> – {f.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pd-section" aria-labelledby="pd-alerts-heading">
        <h2 id="pd-alerts-heading">Alerts</h2>
        <div role="status" aria-live="polite" className="pd-ack-status">
          {ackMessage ? <p className={ackMessage.tone === 'error' ? 'form-error' : 'pd-ok'}>{ackMessage.text}</p> : null}
        </div>
        {sortedAlerts.length === 0 ? (
          <p className="pd-empty">No alerts.</p>
        ) : (
          <ul className="pd-list">
            {sortedAlerts.map((a) => (
              <li key={a.id} className="pd-card" data-alert-status={a.status}>
                <div className="pd-card__head">
                  <RiskChip level={a.severity} />
                  <span>
                    {a.severity} alert · <strong>{ALERT_STATUS_LABELS[a.status]}</strong>
                  </span>
                  {isDoctor && a.status === 'open' ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={ackBusy === a.id}
                      onClick={() => void onAcknowledge(a.id)}
                      aria-label={`Acknowledge ${a.severity} alert raised ${formatDateTime(a.created_at)}`}
                    >
                      {ackBusy === a.id ? 'Acknowledging…' : 'Acknowledge'}
                    </button>
                  ) : null}
                </div>
                {a.summary ? <p className="pd-card__summary">{a.summary}</p> : null}
                {a.reasons.length > 0 ? (
                  <ul className="pd-reasons">
                    {a.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="pd-card__meta">
                  Raised {formatDateTime(a.created_at)}
                  {a.acknowledged_at ? ` · Acknowledged ${formatDateTime(a.acknowledged_at)}` : ''}
                  {a.closed_at ? ` · Closed ${formatDateTime(a.closed_at)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {actions != null && actions !== false ? (
        <div className="pd-section pd-actions" role="group" aria-label="Doctor actions">
          {actions}
        </div>
      ) : null}

      <PatientTimeline detail={shown} today={today} />

      <section className="pd-section" aria-labelledby="pd-tasks-heading">
        <h2 id="pd-tasks-heading">Tasks</h2>
        {sortedTasks.length === 0 ? (
          <p className="pd-empty">No tasks issued.</p>
        ) : (
          <ul className="pd-list">
            {sortedTasks.map((t) => {
              const overdue = isTaskOverdue(t, today);
              return (
                <li key={t.id} className="pd-card" data-task-status={t.status}>
                  <div className="pd-card__head">
                    <strong>{actionLabel('en', t.action_type)}</strong>
                    <span className={`pd-status pd-status--${t.status}`}>Status: {TASK_STATUS_LABELS[t.status]}</span>
                    {overdue ? (
                      <span className="pd-tag pd-tag--overdue">
                        <span aria-hidden="true">⏰ </span>Overdue
                      </span>
                    ) : null}
                    {t.alert_id ? <span className="pd-tag">Linked to alert</span> : null}
                  </div>
                  {t.instructions ? <p className="pd-card__summary">{t.instructions}</p> : null}
                  <p className="pd-card__meta">
                    Due {t.due_date} · Issued {formatDateTime(t.created_at)}
                    {t.issued_by_name ? ` by ${t.issued_by_name}` : ''}
                    {t.done_at ? ` · Done ${formatDateTime(t.done_at)}` : ''}
                  </p>
                  {t.done_note ? <p className="pd-card__meta">Note: {t.done_note}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {birth_outcome ? (
        <section className="pd-section" aria-labelledby="pd-outcome-heading">
          <h2 id="pd-outcome-heading">Birth outcome</h2>
          <p>
            {birth_outcome.outcome === 'live_birth' ? 'Live birth' : 'Stillbirth'} on {birth_outcome.delivery_date}
            {birth_outcome.birth_weight_kg != null ? ` · ${birth_outcome.birth_weight_kg.toFixed(2)} kg` : ''}
            {birth_outcome.is_lbw ? ' (low birth weight)' : ''}
          </p>
        </section>
      ) : null}

      <section className="pd-section pd-charts" aria-labelledby="pd-charts-heading">
        <h2 id="pd-charts-heading">Charts</h2>
        <WeightGainChart mother={mother} visits={visits} />
        <HbChart visits={visits} />
        <BpChart visits={visits} />
        <SupplementsChart visits={visits} />
      </section>
    </article>
  );
}

export default PatientDetail;
