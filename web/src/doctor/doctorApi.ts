/**
 * Typed wrappers for the doctor / ANM endpoints (design §17, Req 19–25, 40).
 *
 * Every function goes through `apiFetch`, so the current bearer token is sent and
 * non-2xx responses throw an `ApiError` (Req 37.9). Network errors and aborts are
 * rethrown unchanged. Role checks are the server's: ANMs get 403 on the
 * doctor-only endpoints (tasks/outcome creation, alerts, ack, stream, demo).
 *
 * The SSE stream (`GET /api/alerts/stream`) is not wrapped here because it needs
 * the raw response body; see `live/useLiveEvents.ts`.
 */
import { apiFetch } from '../shared/api';
import type {
  AlertOut,
  BirthOutcomeIn,
  BirthOutcomeOut,
  CensusOut,
  DemoResetOut,
  DemoTriggerRedOut,
  DigestOut,
  DigestSendOut,
  MotherDetailOut,
  NotificationOut,
  OutcomesOut,
  QueueRowOut,
  RiskLevel,
  TaskCreateIn,
  TaskListOut,
  TaskOut,
} from '../shared/types';

/** Path of the doctor-only SSE stream (Req 18.7). */
export const ALERT_STREAM_PATH = '/api/alerts/stream';

/** Default and bounds of `GET /api/notifications?limit=` (Req 17.4). */
export const NOTIFICATIONS_DEFAULT_LIMIT = 50;
export const NOTIFICATIONS_MAX_LIMIT = 200;

export interface QueueFilters {
  village_id?: string | null;
  risk?: RiskLevel | null;
}

export type AlertListStatus = 'open' | 'all';
export type TaskListStatus = 'open' | 'done' | 'overdue' | 'all';

const id = (value: string): string => encodeURIComponent(value);

// ------------------------------------------------------------------ dashboard (doctor, anm)

/** `GET /api/dashboard/census` (Req 20.1). */
export function getCensus(signal?: AbortSignal): Promise<CensusOut> {
  return apiFetch<CensusOut>('/api/dashboard/census', { signal });
}

/** `GET /api/dashboard/queue?village_id=&risk=` (Req 21.1, 21.2). Empty filters are omitted. */
export function getQueue(filters: QueueFilters = {}, signal?: AbortSignal): Promise<QueueRowOut[]> {
  return apiFetch<QueueRowOut[]>('/api/dashboard/queue', {
    query: { village_id: filters.village_id || null, risk: filters.risk || null },
    signal,
  });
}

// ------------------------------------------------------------------ mothers

/** `GET /api/mothers/{id}` (Req 22.1). */
export function getMotherDetail(motherId: string, signal?: AbortSignal): Promise<MotherDetailOut> {
  return apiFetch<MotherDetailOut>(`/api/mothers/${id(motherId)}`, { signal });
}

/** `POST /api/mothers/{id}/tasks` → 201 with the task (Req 23.2). Doctor only. */
export function createTask(motherId: string, body: TaskCreateIn, signal?: AbortSignal): Promise<TaskOut> {
  return apiFetch<TaskOut>(`/api/mothers/${id(motherId)}/tasks`, { method: 'POST', body, signal });
}

/** `POST /api/mothers/{id}/birth-outcome` → 201 (Req 24.1). Doctor only. */
export function recordBirthOutcome(
  motherId: string,
  body: BirthOutcomeIn,
  signal?: AbortSignal,
): Promise<BirthOutcomeOut> {
  return apiFetch<BirthOutcomeOut>(`/api/mothers/${id(motherId)}/birth-outcome`, {
    method: 'POST',
    body,
    signal,
  });
}

// ------------------------------------------------------------------ alerts (doctor)

/** `GET /api/alerts?status=open|all`; `open` means a live RED alert (open/acknowledged/actioned). */
export function listAlerts(status: AlertListStatus = 'open', signal?: AbortSignal): Promise<AlertOut[]> {
  return apiFetch<AlertOut[]>('/api/alerts', { query: { status }, signal });
}

/** `POST /api/alerts/{id}/ack` → the updated alert; 409 `INVALID_STATE` unless open (Req 16.6, 16.7). */
export function ackAlert(alertId: string, signal?: AbortSignal): Promise<AlertOut> {
  return apiFetch<AlertOut>(`/api/alerts/${id(alertId)}/ack`, { method: 'POST', signal });
}

// ------------------------------------------------------------------ tasks, outcomes, notifications, digest

/** `GET /api/tasks?status=` (Req 23.8). */
export function listTasks(status: TaskListStatus = 'all', signal?: AbortSignal): Promise<TaskListOut[]> {
  return apiFetch<TaskListOut[]>('/api/tasks', { query: { status }, signal });
}

/** `GET /api/outcomes` (Req 24.6). */
export function getOutcomes(signal?: AbortSignal): Promise<OutcomesOut> {
  return apiFetch<OutcomesOut>('/api/outcomes', { signal });
}

/** `GET /api/notifications?limit=` newest first; limit clamped to 1–200 (Req 17.4, 25.4). */
export function listNotifications(
  limit: number = NOTIFICATIONS_DEFAULT_LIMIT,
  signal?: AbortSignal,
): Promise<NotificationOut[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), NOTIFICATIONS_MAX_LIMIT) : NOTIFICATIONS_DEFAULT_LIMIT;
  return apiFetch<NotificationOut[]>('/api/notifications', { query: { limit: n }, signal });
}

/** `GET /api/digest`: open AMBER alerts of the last 7 days by village (Req 25.1). */
export function getDigest(signal?: AbortSignal): Promise<DigestOut> {
  return apiFetch<DigestOut>('/api/digest', { signal });
}

/** `POST /api/digest/send`: one mock SMS per ANM; returns the row count (Req 25.2). */
export function sendDigest(signal?: AbortSignal): Promise<DigestSendOut> {
  return apiFetch<DigestSendOut>('/api/digest/send', { method: 'POST', signal });
}

// ------------------------------------------------------------------ demo helpers (doctor; 404 unless MAATRIVA_DEMO=1)

/** `POST /api/demo/trigger-red` (Req 40.3). */
export function demoTriggerRed(signal?: AbortSignal): Promise<DemoTriggerRedOut> {
  return apiFetch<DemoTriggerRedOut>('/api/demo/trigger-red', { method: 'POST', signal });
}

/** `POST /api/demo/reset` (Req 40.4). */
export function demoReset(signal?: AbortSignal): Promise<DemoResetOut> {
  return apiFetch<DemoResetOut>('/api/demo/reset', { method: 'POST', signal });
}
