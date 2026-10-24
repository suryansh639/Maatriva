/**
 * Push-result mapping and pull merge (Req 27.7–27.9, 27.13, 27.15–27.18; design §16).
 *
 * The planning functions are pure:
 * - `mapResults(batch, results)` maps `results[i]` to `batch[i]` by index only, never
 *   by id (two entries for the same mother keep their own fates).
 * - `planBatchFailure(batch, ...)` increments attempts after a failed envelope and,
 *   when a threshold is given, moves entries that reach it to `syncErrors`.
 * - `planPullMerge(local, pending, pull)` decides what a pull writes and deletes.
 *
 * `applyPullMerge(db, pull)` runs the plan in ONE Dexie read-write transaction and
 * writes the cursor last, so a failed merge never advances the cursor (Req 27.15).
 */

import type {
  ChangeResult,
  LocalMother,
  LocalVisit,
  MotherOut,
  PullResponse,
  TaskOut,
  VillageOut,
  VisitOut,
} from '../../shared/types';
import { setMeta, type FieldDb, type LocalTask, type OutboxEntry, type SyncErrorEntry } from '../db';

/** Entries move to `syncErrors` after this many failed envelope attempts (Req 27.13). */
export const MAX_ATTEMPTS = 5;

/** `last_error` / sync-error code used when the result list does not match the batch. */
export const RESULTS_MISMATCH = 'RESULTS_LENGTH_MISMATCH';

// ------------------------------------------------------------------ push results

export interface BatchPlan {
  /** Outbox `seq`s to delete: applied, duplicate, stale, rejected, or moved to errors. */
  deleteSeqs: number[];
  /** Rows to add to `syncErrors`. */
  toSyncErrors: SyncErrorEntry[];
  /** Entries that stay queued, already updated (`attempts`, `last_error`) for a put. */
  keep: OutboxEntry[];
}

function seqOf(entry: OutboxEntry): number {
  if (entry.seq === undefined) throw new Error('outbox entry has no seq');
  return entry.seq;
}

function toSyncError(entry: OutboxEntry, code: string, message: string, at: string): SyncErrorEntry {
  return {
    entity: entry.entity,
    op: entry.op,
    entity_id: entry.entity_id,
    code,
    message,
    data: entry.data,
    created_at: at,
  };
}

/**
 * Increment `attempts` and set `last_error` on every entry of a failed envelope.
 * With `moveAt` (e.g. `MAX_ATTEMPTS` for HTTP 400/422 and a result-length mismatch),
 * entries whose attempts reach it are deleted and stored in `syncErrors`; without it
 * (network errors, timeouts, 5xx: Req 27.10) every entry is kept.
 */
export function planBatchFailure(
  batch: readonly OutboxEntry[],
  code: string,
  message: string,
  opts: { moveAt?: number; nowIso?: string } = {},
): BatchPlan {
  const at = opts.nowIso ?? new Date().toISOString();
  const plan: BatchPlan = { deleteSeqs: [], toSyncErrors: [], keep: [] };
  for (const entry of batch) {
    const attempts = entry.attempts + 1;
    if (opts.moveAt !== undefined && attempts >= opts.moveAt) {
      plan.deleteSeqs.push(seqOf(entry));
      plan.toSyncErrors.push(toSyncError(entry, code, message, at));
    } else {
      plan.keep.push({ ...entry, attempts, last_error: code });
    }
  }
  return plan;
}

/**
 * Map `results[i]` to `batch[i]` (Req 27.7):
 * - `applied`, `duplicate`, `stale`: delete the entry (Req 27.8);
 * - `rejected`: delete it and store its code and message in `syncErrors` (Req 27.9);
 * - an unknown status keeps the entry with one more attempt.
 * If `results.length !== batch.length`, nothing is trusted: every entry is kept with
 * one more attempt, and moves to `syncErrors` on reaching `MAX_ATTEMPTS`.
 */
export function mapResults(
  batch: readonly OutboxEntry[],
  results: readonly ChangeResult[],
  nowIso: string = new Date().toISOString(),
): BatchPlan {
  if (results.length !== batch.length) {
    return planBatchFailure(
      batch,
      RESULTS_MISMATCH,
      `Server returned ${results.length} results for ${batch.length} changes`,
      { moveAt: MAX_ATTEMPTS, nowIso },
    );
  }
  const plan: BatchPlan = { deleteSeqs: [], toSyncErrors: [], keep: [] };
  batch.forEach((entry, i) => {
    const result = results[i];
    switch (result.status) {
      case 'applied':
      case 'duplicate':
      case 'stale':
        plan.deleteSeqs.push(seqOf(entry));
        break;
      case 'rejected':
        plan.deleteSeqs.push(seqOf(entry));
        plan.toSyncErrors.push(
          toSyncError(
            entry,
            result.error?.code ?? 'REJECTED',
            result.error?.message ?? 'Rejected by the server',
            nowIso,
          ),
        );
        break;
      default:
        plan.keep.push({ ...entry, attempts: entry.attempts + 1, last_error: `UNKNOWN_STATUS:${String(result.status)}` });
    }
  });
  return plan;
}

// ------------------------------------------------------------------ pending index

/** Which local rows still have queued outbox entries. */
export interface PendingIndex {
  /** Mother ids with a pending `mother/upsert`. */
  mothers: ReadonlySet<string>;
  /** Visit ids with a pending `visit/create`. */
  visits: ReadonlySet<string>;
  /** Mother ids referenced by a pending `visit/create` (kept on reset). */
  visitMothers: ReadonlySet<string>;
  /** Task ids with a pending `task/complete`. */
  taskCompletions: ReadonlySet<string>;
}

export function buildPendingIndex(outbox: readonly OutboxEntry[]): PendingIndex {
  const mothers = new Set<string>();
  const visits = new Set<string>();
  const visitMothers = new Set<string>();
  const taskCompletions = new Set<string>();
  for (const e of outbox) {
    if (e.entity === 'mother') mothers.add(e.entity_id);
    else if (e.entity === 'visit') {
      visits.add(e.entity_id);
      visitMothers.add(e.data.mother_id.toLowerCase());
    } else if (e.entity === 'task') taskCompletions.add(e.entity_id);
  }
  return { mothers, visits, visitMothers, taskCompletions };
}

// ------------------------------------------------------------------ pull merge plan

/**
 * Local rows the planner may consult. For an incremental pull, only rows whose ids
 * appear in the pull are needed; for a reset, every local row.
 */
export interface LocalSnapshot {
  mothers: readonly LocalMother[];
  visits: readonly LocalVisit[];
  tasks: readonly LocalTask[];
}

export interface TablePlan<T> {
  /** Ids deleted BEFORE the puts are written. */
  deleteIds: string[];
  put: T[];
}

export interface MergePlan {
  reset: boolean;
  villages: TablePlan<VillageOut>;
  mothers: TablePlan<LocalMother>;
  visits: TablePlan<LocalVisit>;
  tasks: TablePlan<LocalTask>;
  /** Written last. */
  cursor: string;
}

export interface PlanOptions {
  /** Merge as `reset: true` whatever the response says (INVALID_CURSOR recovery, Req 27.14). */
  forceReset?: boolean;
  /** Current local village ids; ids missing from the pull are deleted. */
  localVillageIds?: readonly string[];
}

/** Server-owned mother fields (Req 27.17). */
function serverOwned(m: MotherOut): Pick<LocalMother, 'risk_level' | 'risk_updated_at' | 'flags' | 'edd_date' | 'status'> {
  return {
    risk_level: m.risk_level,
    risk_updated_at: m.risk_updated_at,
    flags: m.flags,
    edd_date: m.edd_date,
    status: m.status,
  };
}

function mergeMother(server: MotherOut, local: LocalMother | undefined, pending: boolean): LocalMother {
  if (pending && local) {
    // Keep unsynced client-owned fields; take only the server-owned ones.
    return { ...local, ...serverOwned(server), pending: true };
  }
  const row: LocalMother = { ...server };
  if (pending) row.pending = true;
  return row;
}

function mergeVisit(server: VisitOut, pending: boolean): LocalVisit {
  // Visits are immutable: the server copy is the same record plus server fields.
  const row: LocalVisit = { ...server };
  if (pending) row.pending = true;
  return row;
}

function mergeTask(server: TaskOut, local: LocalTask | undefined, pendingDone: boolean): LocalTask {
  if (!pendingDone) return { ...server };
  // A queued local completion stays done until the server confirms it (Req 27.18).
  return {
    ...server,
    status: 'done',
    is_overdue: false,
    done_at: local?.done_at ?? server.done_at,
    done_note: local?.done_note ?? server.done_note,
    pending: true,
  };
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Pure merge planner (Req 27.16–27.18):
 * - a pulled mother with a pending outbox entry keeps her local client-owned fields and
 *   takes only `risk_level`, `risk_updated_at`, `flags`, `edd_date` and `status`;
 * - a pulled task with a pending `task/complete` stays `done`;
 * - every other pulled row replaces the local one (and `pending` is cleared);
 * - on reset, every local mother, visit and task with no pending outbox entry (and
 *   not the mother of a pending visit) is deleted before the snapshot is stored;
 * - villages always mirror the pull, which lists every village in scope (Req 12.6).
 */
export function planPullMerge(
  local: LocalSnapshot,
  pending: PendingIndex,
  pull: PullResponse,
  opts: PlanOptions = {},
): MergePlan {
  const reset = pull.reset || opts.forceReset === true;
  const localMothers = byId(local.mothers);
  const localTasks = byId(local.tasks);

  const pulledVillageIds = new Set(pull.villages.map((v) => v.id));
  const villages: TablePlan<VillageOut> = {
    deleteIds: (opts.localVillageIds ?? []).filter((id) => !pulledVillageIds.has(id)),
    put: [...pull.villages],
  };

  const mothers: TablePlan<LocalMother> = {
    deleteIds: [],
    put: pull.mothers.map((m) => mergeMother(m, localMothers.get(m.id), pending.mothers.has(m.id))),
  };
  const visits: TablePlan<LocalVisit> = {
    deleteIds: [],
    put: pull.visits.map((v) => mergeVisit(v, pending.visits.has(v.id))),
  };
  const tasks: TablePlan<LocalTask> = {
    deleteIds: [],
    put: pull.tasks.map((t) => mergeTask(t, localTasks.get(t.id), pending.taskCompletions.has(t.id))),
  };

  if (reset) {
    mothers.deleteIds = local.mothers
      .filter((m) => !pending.mothers.has(m.id) && !pending.visitMothers.has(m.id))
      .map((m) => m.id);
    visits.deleteIds = local.visits.filter((v) => !pending.visits.has(v.id)).map((v) => v.id);
    tasks.deleteIds = local.tasks.filter((t) => !pending.taskCompletions.has(t.id)).map((t) => t.id);
  }

  return { reset, villages, mothers, visits, tasks, cursor: pull.cursor };
}

// ------------------------------------------------------------------ Dexie apply

export interface ApplyOptions {
  /** Merge as `reset: true` (INVALID_CURSOR recovery pull, Req 27.14). */
  forceReset?: boolean;
  /**
   * Runs inside the transaction after all rows are written and before the cursor.
   * Throwing aborts the whole merge (used by tests to prove the cursor is written last).
   */
  beforeCursorWrite?: () => void | Promise<void>;
}

/**
 * Merge a pull response into the device database in ONE read-write transaction and
 * write the cursor last (Req 27.15). Returns the plan that was applied.
 */
export async function applyPullMerge(db: FieldDb, pull: PullResponse, opts: ApplyOptions = {}): Promise<MergePlan> {
  const reset = pull.reset || opts.forceReset === true;
  return db.transaction(
    'rw',
    [db.villages, db.mothers, db.visits, db.tasks, db.outbox, db.meta],
    async () => {
      const pending = buildPendingIndex(await db.outbox.toArray());
      const localVillageIds = (await db.villages.toCollection().primaryKeys()) as string[];

      let local: LocalSnapshot;
      if (reset) {
        local = {
          mothers: await db.mothers.toArray(),
          visits: await db.visits.toArray(),
          tasks: await db.tasks.toArray(),
        };
      } else {
        const defined = <T>(rows: (T | undefined)[]): T[] => rows.filter((r): r is T => r !== undefined);
        local = {
          mothers: defined(await db.mothers.bulkGet(pull.mothers.map((m) => m.id))),
          visits: [],
          tasks: defined(await db.tasks.bulkGet(pull.tasks.map((t) => t.id))),
        };
      }

      const plan = planPullMerge(local, pending, pull, { forceReset: opts.forceReset, localVillageIds });

      await db.villages.bulkDelete(plan.villages.deleteIds);
      await db.mothers.bulkDelete(plan.mothers.deleteIds);
      await db.visits.bulkDelete(plan.visits.deleteIds);
      await db.tasks.bulkDelete(plan.tasks.deleteIds);

      await db.villages.bulkPut(plan.villages.put);
      await db.mothers.bulkPut(plan.mothers.put);
      await db.visits.bulkPut(plan.visits.put);
      await db.tasks.bulkPut(plan.tasks.put);

      if (opts.beforeCursorWrite) await opts.beforeCursorWrite();
      await setMeta(db, 'cursor', plan.cursor);
      return plan;
    },
  );
}

/**
 * Apply a push `BatchPlan` to the outbox and `syncErrors` in one transaction.
 */
export async function applyBatchPlan(db: FieldDb, plan: BatchPlan): Promise<void> {
  await db.transaction('rw', db.outbox, db.syncErrors, async () => {
    await db.outbox.bulkDelete(plan.deleteSeqs);
    if (plan.keep.length) await db.outbox.bulkPut(plan.keep);
    if (plan.toSyncErrors.length) await db.syncErrors.bulkAdd(plan.toSyncErrors);
  });
}
