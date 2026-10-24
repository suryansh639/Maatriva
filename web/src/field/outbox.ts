/**
 * Local-first writes (Req 26.2–26.4).
 *
 * `saveMother`, `saveVisit` and `completeTask` each run ONE Dexie read-write
 * transaction that writes the entity row and appends its outbox entry, so the UI and
 * the outbox can never disagree. Ids come from `newId()` (Req 26.3) and timestamps
 * are UTC ISO-8601 strings with a "Z" suffix. Rows written here carry
 * `pending: true` until a pull replaces them; a newly registered mother also has
 * `risk_level: null`, which the UI renders as "Risk: pending sync" (Req 26.4).
 *
 * Validation (Req 11 / 29.7) is the form's job (`validation.ts`); these functions
 * store what they are given.
 */

import { nowIsoZ, systemClock, type Clock } from '../shared/time';
import type { LocalMother, LocalVisit, MotherIn, TaskCompleteIn, VisitIn } from '../shared/types';
import { newId } from '../shared/uuid';
import { getDeviceId, type FieldDb, type LocalTask, type OutboxEntry, type SyncErrorEntry } from './db';

export interface WriteOptions {
  /** Clock for `updated_at`, `client_created_at`, `done_at` and outbox `created_at`. */
  clock?: Clock;
}

// ------------------------------------------------------------------ write notifications

type WriteListener = () => void;
const listeners = new Set<WriteListener>();

/**
 * Subscribe to committed local writes (the sync engine debounces a cycle 500 ms
 * after the last one, Req 27.1). Returns an unsubscribe function.
 */
export function onLocalWrite(listener: WriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyWrite(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('local write listener failed', err);
    }
  }
}

function newEntry(change: Omit<OutboxEntry, 'seq' | 'created_at' | 'attempts' | 'last_error'>, at: string): OutboxEntry {
  return { ...change, created_at: at, attempts: 0, last_error: null } as OutboxEntry;
}

// ------------------------------------------------------------------ mother upsert

/** Client-owned mother fields; `id` is omitted for a new registration. */
export type MotherDraft = Omit<MotherIn, 'id' | 'registered_at' | 'updated_at'> & {
  id?: string;
  /** Defaults to now for a new mother and to the stored value for an edit. */
  registered_at?: string;
};

/**
 * Register a new mother (no `id`, or an unknown one) or edit an existing one.
 * Edits keep the server-owned fields (`risk_level`, `edd_date`, `status`,
 * `risk_updated_at`, `flags`); `updated_at` is set to now (the LWW key, Req 8.5).
 */
export async function saveMother(db: FieldDb, draft: MotherDraft, opts: WriteOptions = {}): Promise<LocalMother> {
  const now = nowIsoZ(opts.clock ?? systemClock);
  const row = await db.transaction('rw', db.mothers, db.outbox, async () => {
    const id = (draft.id ?? newId()).toLowerCase();
    const existing = await db.mothers.get(id);
    const data: MotherIn = {
      id,
      full_name: draft.full_name,
      age: draft.age,
      guardian_name: draft.guardian_name,
      village_id: draft.village_id,
      phone: draft.phone ?? null,
      lmp_date: draft.lmp_date,
      is_bpl: draft.is_bpl,
      height_cm: draft.height_cm ?? null,
      first_weight_kg: draft.first_weight_kg ?? null,
      registered_at: draft.registered_at ?? existing?.registered_at ?? now,
      updated_at: now,
    };
    const mother: LocalMother = {
      ...data,
      phone: data.phone ?? null,
      height_cm: data.height_cm ?? null,
      first_weight_kg: data.first_weight_kg ?? null,
      risk_level: existing?.risk_level ?? null,
      risk_updated_at: existing?.risk_updated_at ?? null,
      edd_date: existing?.edd_date ?? null,
      status: existing?.status ?? null,
      flags: existing?.flags ?? [],
      pending: true,
    };
    await db.mothers.put(mother);
    await db.outbox.add(newEntry({ entity: 'mother', op: 'upsert', entity_id: id, data }, now));
    return mother;
  });
  notifyWrite();
  return row;
}

// ------------------------------------------------------------------ visit create

/** Visit input fields; the id and `client_created_at` are generated here. */
export type VisitDraft = Omit<VisitIn, 'id' | 'client_created_at'>;

/**
 * Record a new (immutable) visit for a locally known mother. The row carries this
 * device's id; `recorded_by_id` and `received_at` stay null until pulled.
 */
export async function saveVisit(db: FieldDb, draft: VisitDraft, opts: WriteOptions = {}): Promise<LocalVisit> {
  const now = nowIsoZ(opts.clock ?? systemClock);
  const row = await db.transaction('rw', db.visits, db.outbox, db.mothers, db.meta, async () => {
    const motherId = draft.mother_id.toLowerCase();
    if (!(await db.mothers.get(motherId))) {
      throw new Error(`MOTHER_NOT_FOUND: ${motherId}`);
    }
    const deviceId = await getDeviceId(db);
    const data: VisitIn = {
      id: newId(),
      mother_id: motherId,
      visit_date: draft.visit_date,
      weight_kg: draft.weight_kg ?? null,
      weight_source: draft.weight_source ?? null,
      ble_raw_hex: draft.ble_raw_hex ?? null,
      hb_gdl: draft.hb_gdl ?? null,
      hb_source: draft.hb_source ?? null,
      bp_systolic: draft.bp_systolic ?? null,
      bp_diastolic: draft.bp_diastolic ?? null,
      bp_source: draft.bp_source ?? null,
      ifa_tablets: draft.ifa_tablets ?? null,
      calcium_tablets: draft.calcium_tablets ?? null,
      thr_received: draft.thr_received ?? null,
      notes: draft.notes ?? null,
      client_created_at: now,
    };
    const visit: LocalVisit = {
      id: data.id,
      mother_id: data.mother_id,
      visit_date: data.visit_date,
      weight_kg: data.weight_kg ?? null,
      weight_source: data.weight_source ?? null,
      ble_raw_hex: data.ble_raw_hex ?? null,
      hb_gdl: data.hb_gdl ?? null,
      hb_source: data.hb_source ?? null,
      bp_systolic: data.bp_systolic ?? null,
      bp_diastolic: data.bp_diastolic ?? null,
      bp_source: data.bp_source ?? null,
      ifa_tablets: data.ifa_tablets ?? null,
      calcium_tablets: data.calcium_tablets ?? null,
      thr_received: data.thr_received ?? null,
      notes: data.notes ?? null,
      client_created_at: now,
      device_id: deviceId,
      recorded_by_id: null,
      received_at: null,
      pending: true,
    };
    await db.visits.add(visit);
    await db.outbox.add(newEntry({ entity: 'visit', op: 'create', entity_id: visit.id, data }, now));
    return visit;
  });
  notifyWrite();
  return row;
}

// ------------------------------------------------------------------ task complete

/**
 * Mark a task done locally and queue `task/complete` (Req 31.3). Completing a task
 * that is already done is a no-op (no second outbox entry). Throws
 * `TASK_NOT_FOUND` / `TASK_CANCELLED` for a missing or cancelled task.
 */
export async function completeTask(
  db: FieldDb,
  taskId: string,
  note?: string | null,
  opts: WriteOptions = {},
): Promise<LocalTask> {
  const now = nowIsoZ(opts.clock ?? systemClock);
  let wrote = false;
  const row = await db.transaction('rw', db.tasks, db.outbox, async () => {
    const id = taskId.toLowerCase();
    const task = await db.tasks.get(id);
    if (!task) throw new Error(`TASK_NOT_FOUND: ${id}`);
    if (task.status === 'done') return task;
    if (task.status === 'cancelled') throw new Error(`TASK_CANCELLED: ${id}`);
    const doneNote = note?.trim() ? note.trim() : null;
    const data: TaskCompleteIn = { id, done_at: now, done_note: doneNote };
    const updated: LocalTask = {
      ...task,
      status: 'done',
      is_overdue: false,
      done_at: now,
      done_note: doneNote,
      pending: true,
    };
    await db.tasks.put(updated);
    await db.outbox.add(newEntry({ entity: 'task', op: 'complete', entity_id: id, data }, now));
    wrote = true;
    return updated;
  });
  if (wrote) notifyWrite();
  return row;
}

// ------------------------------------------------------------------ read helpers

/** Number of queued outbox entries (the badge "{N} pending", Req 28.1). */
export function pendingCount(db: FieldDb): Promise<number> {
  return db.outbox.count();
}

/** Number of stored sync errors (the badge "{N} sync errors"). */
export function syncErrorCount(db: FieldDb): Promise<number> {
  return db.syncErrors.count();
}

/** Outbox entries in push order (ascending `seq`), optionally the first `limit`. */
export function listOutbox(db: FieldDb, limit?: number): Promise<OutboxEntry[]> {
  const q = db.outbox.orderBy('seq');
  return (limit === undefined ? q : q.limit(limit)).toArray();
}

/** Stored sync errors, newest first. */
export async function listSyncErrors(db: FieldDb): Promise<SyncErrorEntry[]> {
  return (await db.syncErrors.orderBy('id').toArray()).reverse();
}

/** True when `entityId` (any entity) has at least one queued outbox entry. */
export async function hasPending(db: FieldDb, entityId: string): Promise<boolean> {
  return (await db.outbox.where('entity_id').equals(entityId.toLowerCase()).count()) > 0;
}
