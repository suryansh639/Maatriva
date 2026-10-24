/**
 * Pure helpers for the dashboard's live updates (design §17 table, Req 19.8, 19.9, 21.5).
 *
 * Event → effect:
 *
 * | event                      | toast                     | refetch         |
 * |----------------------------|---------------------------|-----------------|
 * | `alert.created` (RED)      | yes, with "Open patient"  | queue + census  |
 * | `alert.updated`            | only if `new_codes` ≠ []  | queue           |
 * | `risk.changed`             | no                        | queue + census  |
 * | `task.done`                | no                        | queue           |
 * | `hello` / `refetchTick`    | no                        | queue + census  |
 *
 * `hello` itself maps to no target here: `useLiveEvents` bumps `refetchTick` on
 * every `hello`, and the page refetches everything on each tick.
 *
 * Refetches go through `createRefetchScheduler`, which debounces (300 ms) and
 * coalesces targets, so a burst of events costs one queue and one census fetch.
 */
import type { AlertOut, QueueRowOut } from '../shared/types';
import type { LiveEvent, LiveMode, LiveStatus } from './live/useLiveEvents';

export const DASHBOARD_REFETCH_DEBOUNCE_MS = 300;

const LIVE_STATUS_TEXT: Readonly<Record<LiveStatus, string>> = {
  idle: '',
  connecting: 'Connecting to live updates…',
  live: 'Live',
  reconnecting: 'Reconnecting – checking for new alerts every 15 s',
  offline: 'Offline – live updates paused',
};

/** The dashboard's live status line (doctor: SSE state; ANM: 30 s auto-refresh). */
export function liveStatusText(live: { mode: LiveMode; status: LiveStatus }): string {
  if (live.mode === 'poll') return 'Auto-refresh every 30 s';
  if (live.mode === 'none') return '';
  return LIVE_STATUS_TEXT[live.status];
}

export type RefetchTarget = 'queue' | 'census';

export const ALL_TARGETS: readonly RefetchTarget[] = ['queue', 'census'];

/** What a live event should refetch on the dashboard. */
export function refetchTargetsFor(ev: LiveEvent): RefetchTarget[] {
  switch (ev.type) {
    case 'alert.created':
    case 'risk.changed':
      return ['queue', 'census'];
    case 'alert.updated':
    case 'task.done':
      return ['queue'];
    default:
      return [];
  }
}

export interface AlertToast {
  title: string;
  message: string;
  motherId: string;
}

/** "Name · Village – first reason", skipping parts the alert does not carry. */
export function alertToastMessage(alert: AlertOut): string {
  const who = [alert.mother_name, alert.village_name].filter((s): s is string => !!s).join(' · ');
  const why = alert.reasons[0] ?? alert.summary ?? '';
  if (who && why) return `${who} – ${why}`;
  return who || why || 'New RED alert';
}

/** The toast for an event, or null when the event shows none. */
export function toastForEvent(ev: LiveEvent): AlertToast | null {
  if (ev.type === 'alert.created') {
    const { alert } = ev.data;
    if (!alert || alert.severity !== 'RED') return null;
    return { title: 'RED alert', message: alertToastMessage(alert), motherId: alert.mother_id };
  }
  if (ev.type === 'alert.updated') {
    const { alert, new_codes } = ev.data;
    if (!alert || alert.severity !== 'RED' || !Array.isArray(new_codes) || new_codes.length === 0) return null;
    return { title: 'RED alert updated', message: alertToastMessage(alert), motherId: alert.mother_id };
  }
  return null;
}

/**
 * Optimistic update for a new RED alert (Req 19.8): the mother's row, when it is
 * in the current list, moves to the top as RED with the alert linked. Rows of
 * other mothers keep their order. The debounced refetch then brings the server's
 * order, flags and counts. Returns the same array when the mother is not listed.
 */
export function promoteAlertInQueue(rows: readonly QueueRowOut[], alert: AlertOut): readonly QueueRowOut[] {
  const id = alert.mother_id.toLowerCase();
  const idx = rows.findIndex((r) => r.mother_id.toLowerCase() === id);
  if (idx < 0) return rows;
  const row: QueueRowOut = {
    ...rows[idx],
    risk_level: 'RED',
    open_alert_id: alert.id,
    open_alert_status: alert.status,
    risk_updated_at: alert.updated_at ?? alert.created_at,
  };
  return [row, ...rows.slice(0, idx), ...rows.slice(idx + 1)];
}

/** A row that has a live RED alert but is no longer RED (Req 21.5). */
export function isResolvedSinceAlert(row: Pick<QueueRowOut, 'open_alert_id' | 'risk_level'>): boolean {
  return row.open_alert_id != null && row.risk_level !== 'RED';
}

/** The first flag's reason (the server sorts RED flags first), or null. */
export function topReason(row: Pick<QueueRowOut, 'flags'>): string | null {
  return row.flags[0]?.reason ?? null;
}

/** Stable key of a set of alert ids, to detect alerts found by the 15 s poll. */
export function alertIdsKey(alerts: readonly Pick<AlertOut, 'id'>[]): string {
  return alerts
    .map((a) => a.id)
    .sort()
    .join(',');
}

export interface RefetchScheduler {
  /** Queue targets; the flush runs `delayMs` after the last call. */
  schedule: (targets: Iterable<RefetchTarget>) => void;
  /** Drop pending targets and the timer. */
  cancel: () => void;
}

/** Debounced, coalescing refetch scheduler. `flush` receives each pending target once. */
export function createRefetchScheduler(
  flush: (targets: ReadonlySet<RefetchTarget>) => void,
  delayMs: number = DASHBOARD_REFETCH_DEBOUNCE_MS,
): RefetchScheduler {
  let pending = new Set<RefetchTarget>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = new Set();
  };

  const schedule = (targets: Iterable<RefetchTarget>) => {
    let added = false;
    for (const t of targets) {
      pending.add(t);
      added = true;
    }
    if (!added && pending.size === 0) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const due = pending;
      pending = new Set();
      if (due.size > 0) flush(due);
    }, delayMs);
  };

  return { schedule, cancel };
}
