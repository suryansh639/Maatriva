/**
 * Closed-loop patient timeline (Req 22.6, 22.7). Pure; the doctor area is English only.
 *
 * Entries:
 * - one per visit (at the visit date, 00:00 IST);
 * - one per non-null alert timestamp: created, acknowledged, closed;
 * - per task: issued (`created_at`), done (`done_at`, when set) and an `overdue`
 *   marker when the task is open and its due date is before `today`
 *   (at 00:00 IST on the day after the due date, when it became overdue);
 * - optionally the birth outcome (at the delivery date, 00:00 IST).
 *
 * Entries are sorted by `(at, kindOrder, id)`. A `task_done` entry has
 * `loopClosed: true` when its task has an `alert_id`; the UI renders "Loop closed".
 */
import { actionLabel } from '../shared/i18n';
import { addDays, IST_OFFSET_MS, parseIsoDate, parseIsoZ } from '../shared/time';
import type { AlertOut, BirthOutcomeOut, MotherDetailOut, TaskOut, VisitOut } from '../shared/types';

export const LOOP_CLOSED_LABEL = 'Loop closed';

export type TimelineKind =
  | 'visit'
  | 'alert_created'
  | 'alert_acknowledged'
  | 'task_issued'
  | 'task_done'
  | 'task_overdue'
  | 'alert_closed'
  | 'birth_outcome';

/** Tie-break order for entries at the same instant (cause before effect). */
export const KIND_ORDER: Readonly<Record<TimelineKind, number>> = {
  visit: 0,
  alert_created: 1,
  alert_acknowledged: 2,
  task_issued: 3,
  task_done: 4,
  task_overdue: 5,
  alert_closed: 6,
  birth_outcome: 7,
};

export interface TimelineEntry {
  /** Unique within a timeline: `${kind}:${sourceId}`. */
  id: string;
  kind: TimelineKind;
  /** Epoch milliseconds used for ordering. */
  at: number;
  /** Source id of the visit, alert, task or birth outcome. */
  refId: string;
  label: string;
  detail: string | null;
  /** Alert severity for alert entries, otherwise null. */
  severity: string | null;
  /** True only for a `task_done` entry whose task is linked to an alert. */
  loopClosed: boolean;
}

/** 00:00 IST of a "YYYY-MM-DD" date, as epoch ms. */
function istMidnightMs(date: string): number {
  return parseIsoDate(date) - IST_OFFSET_MS;
}

function visitDetail(v: VisitOut): string | null {
  const parts: string[] = [];
  if (v.weight_kg != null) parts.push(`Weight ${v.weight_kg.toFixed(1)} kg${v.weight_source ? ` (${v.weight_source})` : ''}`);
  if (v.hb_gdl != null) parts.push(`Hb ${v.hb_gdl.toFixed(1)} g/dL`);
  if (v.bp_systolic != null && v.bp_diastolic != null) parts.push(`BP ${v.bp_systolic}/${v.bp_diastolic}`);
  if (v.ifa_tablets != null) parts.push(`IFA ${v.ifa_tablets}`);
  if (v.calcium_tablets != null) parts.push(`Calcium ${v.calcium_tablets}`);
  if (v.thr_received != null) parts.push(`THR ${v.thr_received ? 'yes' : 'no'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function taskLabel(t: TaskOut): string {
  return actionLabel('en', t.action_type);
}

/** True when the task is open and its due date is before `today` (Req 12.10). */
export function isTaskOverdue(task: Pick<TaskOut, 'status' | 'due_date'>, today: string): boolean {
  return task.status === 'open' && task.due_date < today;
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at !== b.at) return a.at - b.at;
  const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (k !== 0) return k;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildTimeline(
  visits: readonly VisitOut[],
  alerts: readonly AlertOut[],
  tasks: readonly TaskOut[],
  today: string,
  birthOutcome: BirthOutcomeOut | null = null,
): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const push = (e: Omit<TimelineEntry, 'id' | 'severity' | 'loopClosed'> & Partial<TimelineEntry>): void => {
    out.push({ severity: null, loopClosed: false, ...e, id: `${e.kind}:${e.refId}` });
  };

  for (const v of visits) {
    push({ kind: 'visit', at: istMidnightMs(v.visit_date), refId: v.id, label: 'Visit recorded', detail: visitDetail(v) });
  }

  for (const a of alerts) {
    const summary = a.summary || null;
    push({
      kind: 'alert_created',
      at: parseIsoZ(a.created_at),
      refId: a.id,
      label: `${a.severity} alert raised`,
      detail: summary,
      severity: a.severity,
    });
    if (a.acknowledged_at) {
      push({
        kind: 'alert_acknowledged',
        at: parseIsoZ(a.acknowledged_at),
        refId: a.id,
        label: `${a.severity} alert acknowledged`,
        detail: null,
        severity: a.severity,
      });
    }
    if (a.closed_at) {
      push({
        kind: 'alert_closed',
        at: parseIsoZ(a.closed_at),
        refId: a.id,
        label: `${a.severity} alert closed`,
        detail: null,
        severity: a.severity,
      });
    }
  }

  for (const t of tasks) {
    const label = taskLabel(t);
    const issuedBy = t.issued_by_name ? ` by ${t.issued_by_name}` : '';
    const issuedDetail = [t.instructions, `Due ${t.due_date}`, t.status === 'cancelled' ? 'Cancelled' : null]
      .filter((s): s is string => !!s)
      .join(' · ');
    push({
      kind: 'task_issued',
      at: parseIsoZ(t.created_at),
      refId: t.id,
      label: `Action issued${issuedBy}: ${label}`,
      detail: issuedDetail,
    });
    if (t.done_at) {
      push({
        kind: 'task_done',
        at: parseIsoZ(t.done_at),
        refId: t.id,
        label: `Action done: ${label}`,
        detail: t.done_note || null,
        loopClosed: t.alert_id != null,
      });
    }
    if (isTaskOverdue(t, today)) {
      push({
        kind: 'task_overdue',
        at: istMidnightMs(addDays(t.due_date, 1)),
        refId: t.id,
        label: `Overdue: ${label}`,
        detail: `Was due ${t.due_date}`,
      });
    }
  }

  if (birthOutcome) {
    const kind = birthOutcome.outcome === 'live_birth' ? 'Live birth' : 'Stillbirth';
    const weight =
      birthOutcome.birth_weight_kg != null
        ? ` · ${birthOutcome.birth_weight_kg.toFixed(2)} kg${birthOutcome.is_lbw ? ' (low birth weight)' : ''}`
        : '';
    push({
      kind: 'birth_outcome',
      at: istMidnightMs(birthOutcome.delivery_date),
      refId: birthOutcome.id,
      label: 'Birth outcome recorded',
      detail: `${kind}${weight}`,
    });
  }

  return out.sort(compareEntries);
}

/** Convenience wrapper for the patient detail response. */
export function buildTimelineFromDetail(detail: MotherDetailOut, today: string): TimelineEntry[] {
  return buildTimeline(detail.visits, detail.alerts, detail.tasks, today, detail.birth_outcome);
}
