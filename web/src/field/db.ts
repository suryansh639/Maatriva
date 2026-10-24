/**
 * Field-area local database (Req 26.1).
 *
 * One Dexie database per signed-in user, `maatriva-field-<userId>`, so a shared
 * phone never leaks one ASHA's records to another. Logging out closes the handle
 * but never deletes the database (Req 37.7); the only bulk deletion of rows is the
 * `reset: true` pull merge in `sync/merge.ts`.
 *
 * Schema v1 (design §16):
 *   mothers    'id, village_id, full_name, risk_level, updated_at'
 *   visits     'id, mother_id, visit_date'
 *   tasks      'id, mother_id, status, due_date'
 *   villages   'id'
 *   outbox     '++seq, entity, entity_id'   ordered by the auto-increment `seq`
 *   syncErrors '++id, entity_id'            rejected changes, shown in UI, never retried
 *   meta       'key'                        cursor, lastSyncAt, deviceId
 */

import Dexie, { type EntityTable, type Table } from 'dexie';

import type { ChangeIn, LocalMother, LocalVisit, SyncEntity, TaskOut, VillageOut } from '../shared/types';
import { newId } from '../shared/uuid';

// ------------------------------------------------------------------ row types

/** A task as stored on the device; `pending` marks a queued local completion. */
export interface LocalTask extends TaskOut {
  pending?: boolean;
}

export type OutboxOp = ChangeIn['op'];

/**
 * One queued local change. `entity`/`op`/`data` are sent verbatim as a push change;
 * `attempts` and `last_error` record failed push attempts (Req 27.10, 27.13).
 * An entry is "queued" while `attempts === 0` and "retrying" afterwards.
 */
export type OutboxEntry = ChangeIn & {
  /** Auto-increment key; push order (Req 27.5). Absent only before insertion. */
  seq?: number;
  entity_id: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
};

/** A change the server rejected, or that failed 5 envelope attempts (Req 27.9, 27.13). */
export interface SyncErrorEntry {
  id?: number;
  entity: SyncEntity | string;
  op: OutboxOp | string;
  entity_id: string | null;
  code: string;
  message: string;
  data: unknown;
  created_at: string;
}

/** Known `meta` keys and their value types. */
export interface MetaValues {
  /** Pull cursor `"<epoch>:<seq>"`, or `"0"` for a full snapshot. Stored verbatim. */
  cursor: string;
  /** ISO-8601 instant of the last successful cycle. */
  lastSyncAt: string;
  /** This device's UUID, sent as the push envelope `device_id`. */
  deviceId: string;
}

export type MetaKey = keyof MetaValues;

export interface MetaEntry<K extends MetaKey = MetaKey> {
  key: K;
  value: MetaValues[K];
}

// ------------------------------------------------------------------ database

export const DB_NAME_PREFIX = 'maatriva-field-';

/** The per-user database name (Req 26.1). */
export function fieldDbName(userId: string): string {
  return `${DB_NAME_PREFIX}${userId}`;
}

export class FieldDb extends Dexie {
  mothers!: EntityTable<LocalMother, 'id'>;
  visits!: EntityTable<LocalVisit, 'id'>;
  tasks!: EntityTable<LocalTask, 'id'>;
  villages!: EntityTable<VillageOut, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'seq'>;
  syncErrors!: EntityTable<SyncErrorEntry, 'id'>;
  meta!: Table<MetaEntry, MetaKey>;

  readonly userId: string;

  constructor(userId: string) {
    super(fieldDbName(userId));
    this.userId = userId;
    this.version(1).stores({
      mothers: 'id, village_id, full_name, risk_level, updated_at',
      visits: 'id, mother_id, visit_date',
      tasks: 'id, mother_id, status, due_date',
      villages: 'id',
      outbox: '++seq, entity, entity_id',
      syncErrors: '++id, entity_id',
      meta: 'key',
    });
  }
}

let current: FieldDb | null = null;

/** The database of `userId`, reusing the open handle for the same user. */
export function openFieldDb(userId: string): FieldDb {
  if (current && current.userId === userId) return current;
  current?.close();
  current = new FieldDb(userId);
  return current;
}

/**
 * Close the current handle (logout). The data stays on the device (Req 37.7).
 * With `db`, only closes when that handle is still the current one.
 */
export function closeFieldDb(db?: FieldDb): void {
  if (db && current !== db) return;
  current?.close();
  current = null;
}

const holders = new Map<FieldDb, number>();

/**
 * Mark `db` as in use by a mounted field area; returns the release function.
 *
 * The last release closes the handle on a later tick (`defer`, default
 * `setTimeout(…, 0)`), so the live queries of the unmounting screens unsubscribe
 * first, and a remount in between (React StrictMode, a quick re-login of the same
 * user) keeps the handle open.
 */
export function retainFieldDb(
  db: FieldDb,
  defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 0),
): () => void {
  holders.set(db, (holders.get(db) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holders.get(db) ?? 1) - 1;
    if (n > 0) {
      holders.set(db, n);
      return;
    }
    holders.delete(db);
    defer(() => {
      if (!holders.has(db)) closeFieldDb(db);
    });
  };
}

// ------------------------------------------------------------------ meta helpers

export async function getMeta<K extends MetaKey>(db: FieldDb, key: K): Promise<MetaValues[K] | undefined> {
  const row = await db.meta.get(key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(db: FieldDb, key: K, value: MetaValues[K]): Promise<void> {
  await db.meta.put({ key, value } as MetaEntry);
}

/** The stored pull cursor, `"0"` when none has been saved yet. */
export async function getCursor(db: FieldDb): Promise<string> {
  return (await getMeta(db, 'cursor')) ?? '0';
}

/**
 * This device's id: generated once with `newId()` and persisted in `meta`. Safe to
 * call inside a transaction that includes `db.meta` in read-write mode.
 */
export async function getDeviceId(db: FieldDb): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const existing = await getMeta(db, 'deviceId');
    if (existing) return existing;
    const id = newId();
    await setMeta(db, 'deviceId', id);
    return id;
  });
}
