/**
 * Field mother detail (Req 26.4, 29.8, 29.9, 29.10, 32.2).
 *
 * Local data only: profile (guardian, village, age, phone, Short_Code, height,
 * status, BPL / Demo tags), the risk chip ("Risk: pending sync" until the first
 * pull), active flags as the translated label plus the server's English reason,
 * GA today and EDD, the visits list (newest first), a lazy-loaded weight chart
 * (empty-state text below 2 weights, without loading the chart bundle), this
 * mother's tasks and a "New visit" button that opens `newVisitPath`.
 *
 * Route: `/field/mother/:motherId` (task 18.8 mounts it); `motherId` may also be
 * passed as a prop.
 */
import { Suspense, lazy, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { eddNaegele } from '../../shared/gestation';
import { useI18n } from '../../shared/I18nProvider';
import { RiskChip } from '../../shared/RiskChip';
import { istDate, parseIsoZ, todayIST } from '../../shared/time';
import type { LocalMother, LocalVisit } from '../../shared/types';
import type { WeightPoint } from '../components/WeightChart';
import type { LocalTask } from '../db';
import { isDemoMother, shortCode } from '../mothersList';
import { FIELD_PATHS, newVisitPath } from '../paths';
import { useSync } from '../sync/SyncProvider';
import { gaToday, usePendingMotherIds } from './MothersList';
import './mothers.css';

const WeightChart = lazy(() => import('../components/WeightChart'));

const EMPTY_VISITS: LocalVisit[] = [];
const EMPTY_TASKS: LocalTask[] = [];

/** Chronological order used by triage: visit_date, then client_created_at. */
function byVisitOrder(a: LocalVisit, b: LocalVisit): number {
  if (a.visit_date !== b.visit_date) return a.visit_date < b.visit_date ? -1 : 1;
  return a.client_created_at < b.client_created_at ? -1 : a.client_created_at > b.client_created_at ? 1 : 0;
}

/** Visit weights in order, plus the registration weight when no visit shares its date. */
export function weightPoints(mother: LocalMother, visits: readonly LocalVisit[]): WeightPoint[] {
  const points: WeightPoint[] = [...visits]
    .sort(byVisitOrder)
    .filter((v) => typeof v.weight_kg === 'number')
    .map((v) => ({ date: v.visit_date, weightKg: v.weight_kg as number }));
  if (typeof mother.first_weight_kg === 'number') {
    const ms = parseIsoZ(mother.registered_at);
    const regDate = Number.isNaN(ms) ? null : istDate(ms);
    if (regDate && !points.some((p) => p.date === regDate)) {
      points.push({ date: regDate, weightKg: mother.first_weight_kg });
      points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
  }
  return points;
}

/** Open tasks first (by due date), then done, then cancelled. */
function taskOrder(a: LocalTask, b: LocalTask): number {
  const rank = (s: LocalTask['status']) => (s === 'open' ? 0 : s === 'done' ? 1 : 2);
  return rank(a.status) - rank(b.status) || (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const ms = parseIsoZ(iso);
  return Number.isNaN(ms) ? iso : istDate(ms);
}

export interface MotherDetailProps {
  motherId?: string;
}

export function MotherDetail({ motherId: idProp }: MotherDetailProps) {
  const { t, flagLabel, actionLabel } = useI18n();
  const { db } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ motherId: string }>();
  const motherId = (idProp ?? params.motherId ?? '').toLowerCase();
  // `saved: true` after registration, `saved: 'visit'` after a new visit (NewVisit).
  const savedState = (location.state as { saved?: boolean | 'visit' } | null)?.saved;
  const justSaved = Boolean(savedState);

  // `{ mother: null }` means "not on this phone"; `undefined` means still loading.
  const found = useLiveQuery(async () => ({ mother: (await db.mothers.get(motherId)) ?? null }), [db, motherId]);
  const mother = found?.mother ?? null;
  const villageName = useLiveQuery(
    async () => (mother ? ((await db.villages.get(mother.village_id))?.name ?? '') : ''),
    [db, mother?.village_id],
    '',
  );
  const visits = useLiveQuery(
    () => db.visits.where('mother_id').equals(motherId).toArray(),
    [db, motherId],
    EMPTY_VISITS,
  );
  const tasks = useLiveQuery(
    () => db.tasks.where('mother_id').equals(motherId).toArray(),
    [db, motherId],
    EMPTY_TASKS,
  );
  const pendingIds = usePendingMotherIds(db);

  const sortedVisits = useMemo(() => [...visits].sort(byVisitOrder).reverse(), [visits]);
  const sortedTasks = useMemo(() => [...tasks].sort(taskOrder), [tasks]);
  const points = useMemo(() => (mother ? weightPoints(mother, visits) : []), [mother, visits]);

  if (found === undefined) {
    return (
      <section className="field-screen">
        <p role="status">{t('field.common.loading')}</p>
      </section>
    );
  }

  if (!mother) {
    return (
      <section className="field-screen" aria-labelledby="detail-title">
        <h1 id="detail-title">{t('field.detail.title')}</h1>
        <p role="alert">{t('field.detail.notFound')}</p>
        <Link to={FIELD_PATHS.mothers} className="btn btn--link">
          {t('field.common.back')}
        </Link>
      </section>
    );
  }

  const today = todayIST();
  const ga = gaToday(mother.lmp_date);
  let edd = mother.edd_date;
  if (!edd) {
    try {
      edd = eddNaegele(mother.lmp_date);
    } catch {
      edd = null;
    }
  }
  const pending = Boolean(mother.pending) || pendingIds.has(mother.id);
  const delivered = mother.status === 'delivered';

  return (
    <section className="field-screen mother-detail" aria-labelledby="detail-title" data-mother-id={mother.id}>
      <Link to={FIELD_PATHS.mothers} className="mother-detail__back">
        <span aria-hidden="true">← </span>
        {t('field.common.back')}
      </Link>

      <header className="mother-detail__header">
        <h1 id="detail-title">{mother.full_name}</h1>
        <div className="mother-detail__chips">
          <RiskChip level={mother.risk_level} />
          {isDemoMother(mother) ? (
            <span className="tag tag--demo" data-testid="demo-tag">
              {t('field.common.demoTag')}
            </span>
          ) : null}
          {mother.is_bpl ? <span className="tag tag--bpl">{t('field.common.bplTag')}</span> : null}
          {pending ? (
            <span className="tag tag--pending" data-testid="pending-marker">
              <span aria-hidden="true">⟳ </span>
              {t('field.common.pendingMarker')}
            </span>
          ) : null}
        </div>
      </header>

      {justSaved ? (
        <p className="mother-detail__saved" role="status" data-testid="saved-notice">
          {t(savedState === 'visit' ? 'field.visit.saved' : 'field.register.saved')}
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn--primary btn--block"
        data-testid="new-visit"
        disabled={delivered}
        onClick={() => navigate(newVisitPath(mother.id))}
      >
        <span aria-hidden="true">＋ </span>
        {t('field.detail.newVisit')}
      </button>

      <section className="detail-section" aria-labelledby="detail-profile">
        <h2 id="detail-profile">{t('field.detail.profile')}</h2>
        <dl className="detail-grid">
          <dt>{t('field.detail.ga')}</dt>
          <dd data-testid="detail-ga">{ga ?? '–'}</dd>
          <dt>{t('field.detail.edd')}</dt>
          <dd>{edd ?? '–'}</dd>
          <dt>{t('field.detail.guardian')}</dt>
          <dd>{mother.guardian_name}</dd>
          <dt>{t('field.detail.village')}</dt>
          <dd>{villageName || '–'}</dd>
          <dt>{t('field.register.age')}</dt>
          <dd>{mother.age}</dd>
          <dt>{t('field.detail.phone')}</dt>
          <dd>{mother.phone ?? '–'}</dd>
          <dt>{t('field.detail.code')}</dt>
          <dd className="mono">{shortCode(mother.id)}</dd>
          <dt>{t('field.detail.height')}</dt>
          <dd>{mother.height_cm !== null ? `${mother.height_cm} cm` : '–'}</dd>
          {mother.status ? (
            <>
              <dt>{t('field.detail.status')}</dt>
              <dd>{t(delivered ? 'field.detail.statusDelivered' : 'field.detail.statusActive')}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section className="detail-section" aria-labelledby="detail-flags">
        <h2 id="detail-flags">{t('field.detail.flags')}</h2>
        {mother.risk_level === null ? (
          <p>{t('risk.pending')}</p>
        ) : mother.flags.length === 0 ? (
          <p>{t('field.detail.noFlags')}</p>
        ) : (
          <ul className="flag-list" data-testid="flag-list">
            {mother.flags.map((f) => (
              <li key={f.code} className={`flag-item flag-item--${String(f.severity).toLowerCase()}`}>
                <span className="flag-item__icon" aria-hidden="true">
                  {f.severity === 'RED' ? '▲' : '◆'}
                </span>
                <span>
                  <strong>{flagLabel(f.code)}</strong>
                  <span className="flag-item__reason" lang="en">
                    {f.reason}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail-section" aria-labelledby="detail-chart">
        <h2 id="detail-chart">{t('field.detail.weightChart')}</h2>
        {points.length < 2 ? (
          <p className="weight-chart__empty">{t('field.detail.chartEmpty')}</p>
        ) : (
          <Suspense fallback={<p role="status">{t('field.common.loading')}</p>}>
            <WeightChart points={points} />
          </Suspense>
        )}
      </section>

      <section className="detail-section" aria-labelledby="detail-visits">
        <h2 id="detail-visits">{t('field.detail.visits')}</h2>
        {sortedVisits.length === 0 ? (
          <p>{t('field.detail.noVisits')}</p>
        ) : (
          <ul className="visit-list" data-testid="visit-list">
            {sortedVisits.map((v) => (
              <li key={v.id} className="visit-item">
                <p className="visit-item__date">
                  <time dateTime={v.visit_date}>{v.visit_date}</time>
                  {v.pending ? (
                    <span className="tag tag--pending">
                      <span aria-hidden="true">⟳ </span>
                      {t('field.common.pendingMarker')}
                    </span>
                  ) : null}
                </p>
                <p className="visit-item__values">
                  {v.weight_kg !== null ? <span>{t('field.detail.visitWeight', { w: v.weight_kg.toFixed(2) })}</span> : null}
                  {v.hb_gdl !== null ? <span>{t('field.detail.visitHb', { hb: v.hb_gdl.toFixed(1) })}</span> : null}
                  {v.bp_systolic !== null && v.bp_diastolic !== null ? (
                    <span>{t('field.detail.visitBp', { s: v.bp_systolic, d: v.bp_diastolic })}</span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="detail-section" aria-labelledby="detail-tasks">
        <h2 id="detail-tasks">{t('field.detail.tasks')}</h2>
        {sortedTasks.length === 0 ? (
          <p>{t('field.detail.noTasks')}</p>
        ) : (
          <ul className="detail-task-list">
            {sortedTasks.map((task) => {
              const overdue = task.status === 'open' && (task.is_overdue || task.due_date < today);
              return (
                <li key={task.id} className="detail-task" data-task-status={task.status}>
                  <p className="detail-task__title">
                    <strong>{actionLabel(task.action_type)}</strong>
                  </p>
                  {task.instructions ? <p>{task.instructions}</p> : null}
                  <p className="detail-task__meta">
                    {task.status === 'done' ? (
                      <span>
                        <span aria-hidden="true">✓ </span>
                        {t('field.tasks.doneOn', { date: formatDateTime(task.done_at) })}
                      </span>
                    ) : task.status === 'cancelled' ? (
                      <span>{t('field.tasks.cancelled')}</span>
                    ) : (
                      <>
                        <span>{t('field.tasks.due', { date: task.due_date })}</span>
                        {overdue ? (
                          <span className="tag tag--overdue">
                            <span aria-hidden="true">⚠ </span>
                            {t('field.tasks.overdue')}
                          </span>
                        ) : null}
                      </>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {sortedTasks.some((x) => x.status === 'open') ? (
          <Link to={FIELD_PATHS.tasks} className="mother-detail__tasks-link">
            {t('field.nav.tasks')}
          </Link>
        ) : null}
      </section>
    </section>
  );
}

export default MotherDetail;
