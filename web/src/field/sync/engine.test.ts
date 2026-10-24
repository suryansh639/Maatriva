/**
 * Sync engine unit tests (task 17.4; Req 27.3, 27.7–27.12, 27.14–27.17, 44.7).
 *
 * Each test gets a fresh, uniquely named Dexie database on `fake-indexeddb` and a
 * scripted `fetch`. Locks are disabled (`locks: null`, the in-module flag is used),
 * and the clock and timers are injected.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeStatus,
  MotherOut,
  PullResponse,
  PushRequest,
  TaskOut,
  VisitOut,
} from '../../shared/types';
import { FieldDb, getCursor, getMeta, setMeta } from '../db';
import { completeTask, listOutbox, saveMother, saveVisit, type MotherDraft } from '../outbox';
import {
  PULL_PATH,
  PUSH_PATH,
  REQUEST_TIMEOUT_MS,
  SyncEngine,
  runCycle,
  type IntervalApi,
  type SyncDeps,
} from './engine';

// ------------------------------------------------------------------ fixtures

const EPOCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VILLAGE = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2025-03-01T06:00:00.000Z');
const clock = () => NOW;

const M1 = '00000000-0000-4000-8000-0000000000a1';
const M2 = '00000000-0000-4000-8000-0000000000a2';
const M3 = '00000000-0000-4000-8000-0000000000a3';
const T1 = '00000000-0000-4000-8000-0000000000c1';
const V1 = '00000000-0000-4000-8000-0000000000b1';

function draft(id: string, fullName = 'Asha Test (synthetic)'): MotherDraft {
  return {
    id,
    full_name: fullName,
    age: 25,
    guardian_name: 'Guardian (synthetic)',
    village_id: VILLAGE,
    phone: null,
    lmp_date: '2024-10-01',
    is_bpl: false,
    height_cm: 155,
    first_weight_kg: 50,
  };
}

function serverMother(id: string, overrides: Partial<MotherOut> = {}): MotherOut {
  return {
    id,
    full_name: 'Server Name (synthetic)',
    age: 25,
    guardian_name: 'Guardian (synthetic)',
    village_id: VILLAGE,
    phone: null,
    lmp_date: '2024-10-01',
    edd_date: '2025-07-08',
    is_bpl: false,
    height_cm: 155,
    first_weight_kg: 50,
    registered_at: '2024-12-01T03:30:00Z',
    updated_at: '2024-12-01T03:30:00Z',
    status: 'active',
    risk_level: 'GREEN',
    risk_updated_at: null,
    flags: [],
    ...overrides,
  };
}

function serverVisit(id: string, motherId: string): VisitOut {
  return {
    id,
    mother_id: motherId,
    visit_date: '2025-02-01',
    weight_kg: 55,
    weight_source: 'manual',
    ble_raw_hex: null,
    hb_gdl: 11.5,
    hb_source: 'manual',
    bp_systolic: null,
    bp_diastolic: null,
    bp_source: null,
    ifa_tablets: null,
    calcium_tablets: null,
    thr_received: null,
    notes: null,
    client_created_at: '2025-02-01T05:00:00Z',
    recorded_by_id: 'asha-1',
    device_id: 'dev-1',
    received_at: '2025-02-01T05:01:00Z',
  };
}

function serverTask(id: string, motherId: string, overrides: Partial<TaskOut> = {}): TaskOut {
  return {
    id,
    mother_id: motherId,
    alert_id: null,
    action_type: 'HOME_VISIT_48H',
    instructions: null,
    due_date: '2025-03-03',
    status: 'open',
    is_overdue: false,
    issued_by_id: 'doc-1',
    issued_by_name: 'Doctor (synthetic)',
    asha_id: 'asha-1',
    created_at: '2025-02-28T05:00:00Z',
    done_at: null,
    done_note: null,
    ...overrides,
  };
}

function pullBody(overrides: Partial<PullResponse> = {}): PullResponse {
  return {
    cursor: `${EPOCH}:100`,
    reset: false,
    server_time: new Date(NOW).toISOString(),
    villages: [{ id: VILLAGE, name: 'Dankaur', lat: 28.35, lng: 77.55 }],
    mothers: [],
    visits: [],
    tasks: [],
    ...overrides,
  };
}

// ------------------------------------------------------------------ fetch harness

interface Call {
  path: string;
  since: string | null;
  body: PushRequest | null;
  auth: string | null;
}

type Step = (call: Call, init: RequestInit | undefined) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const reply =
  (status: number, body: unknown): Step =>
  () =>
    json(status, body);

/** A push reply giving `statuses[i]` to change i (rejected ones get `error`). */
const pushReply =
  (...statuses: ChangeStatus[]): Step =>
  (call) =>
    json(200, {
      server_time: new Date(NOW).toISOString(),
      results: (call.body?.changes ?? []).map((c, i) => ({
        entity: c.entity,
        id: c.data.id,
        status: statuses[i],
        error: statuses[i] === 'rejected' ? { code: 'OUT_OF_SCOPE', message: `change ${i} out of scope` } : null,
      })),
    });

const errorReply = (status: number, code: string, message = code): Step => reply(status, { detail: { code, message } });

/** A fetch that never settles on its own; it rejects when its signal aborts. */
function hanging(onStart?: () => void): Step {
  return (_call, init) =>
    new Promise<Response>((_, reject) => {
      onStart?.();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
}

/**
 * Scripted fetch: push and pull calls consume their own queues in order. When a
 * queue is empty, a push applies every change and a pull returns an empty page.
 */
function scriptedFetch(script: { push?: Step[]; pull?: Step[] } = {}) {
  const pushQ = [...(script.push ?? [])];
  const pullQ = [...(script.pull ?? [])];
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://test.local');
    const headers = new Headers(init?.headers);
    const call: Call = {
      path: url.pathname,
      since: url.searchParams.get('since'),
      body: init?.body ? (JSON.parse(String(init.body)) as PushRequest) : null,
      auth: headers.get('Authorization'),
    };
    calls.push(call);
    if (call.path === PUSH_PATH) {
      const step = pushQ.shift() ?? ((c: Call) => pushReply(...(c.body?.changes ?? []).map(() => 'applied' as const))(c, init));
      return step(call, init);
    }
    if (call.path === PULL_PATH) {
      const step = pullQ.shift() ?? reply(200, pullBody());
      return step(call, init);
    }
    return json(404, { detail: { code: 'NOT_FOUND', message: 'unexpected path' } });
  });
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    pushes: () => calls.filter((c) => c.path === PUSH_PATH),
    pulls: () => calls.filter((c) => c.path === PULL_PATH),
  };
}

/** Timers that only fire when the test says so. */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: IntervalApi = {
    setTimeout: (fn, ms) => {
      const id = ++next;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
    setInterval: () => ++next,
    clearInterval: () => undefined,
  };
  return {
    timers,
    pending,
    fireAll(): void {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
  };
}

// ------------------------------------------------------------------ db lifecycle

let dbCounter = 0;
const openDbs: FieldDb[] = [];

function freshDb(): FieldDb {
  dbCounter += 1;
  const db = new FieldDb(`engine-test-${dbCounter}-${Math.random().toString(36).slice(2)}`);
  openDbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of openDbs.splice(0)) await db.delete();
});

function makeDeps(db: FieldDb, f: ReturnType<typeof scriptedFetch>, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    db,
    getToken: () => 'test-token',
    fetch: f.fetch,
    clock,
    isOnline: () => true,
    isSimOffline: () => false,
    timers: manualTimers().timers,
    locks: null,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...extra,
  };
}

const signal = () => new AbortController().signal;

// ------------------------------------------------------------------ push

describe('runCycle push', () => {
  it('removes applied entries, pulls from the stored cursor and records lastSyncAt', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    await saveVisit(db, { mother_id: M1, visit_date: '2025-03-01', weight_kg: 56.6, weight_source: 'manual' }, { clock });
    await setMeta(db, 'cursor', `${EPOCH}:7`);
    const f = scriptedFetch({ push: [pushReply('applied', 'applied')] });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('ok');
    expect(out.settled).toBe(2);
    expect(await db.outbox.count()).toBe(0);
    const [push] = f.pushes();
    expect(push.auth).toBe('Bearer test-token');
    expect(push.body?.changes.map((c) => `${c.entity}/${c.op}`)).toEqual(['mother/upsert', 'visit/create']);
    expect(f.pulls().map((c) => c.since)).toEqual([`${EPOCH}:7`]);
    expect(await getCursor(db)).toBe(`${EPOCH}:100`);
    expect(await getMeta(db, 'lastSyncAt')).toBe(new Date(NOW).toISOString());
  });

  it('pushes in ascending seq order, in batches, until the outbox is empty', async () => {
    const db = freshDb();
    for (const id of [M1, M2, M3]) await saveMother(db, draft(id), { clock });
    const f = scriptedFetch();

    const out = await runCycle(makeDeps(db, f, { batchSize: 2 }), signal());

    expect(out.status).toBe('ok');
    expect(out.batches).toBe(2);
    expect(f.pushes().map((c) => c.body?.changes.map((ch) => ch.data.id))).toEqual([[M1, M2], [M3]]);
    expect(await db.outbox.count()).toBe(0);
  });

  it('moves rejected entries to syncErrors with the server code and message', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    await saveMother(db, draft(M2), { clock });
    const f = scriptedFetch({ push: [pushReply('applied', 'rejected')] });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('ok');
    expect(out.rejected).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    const errors = await db.syncErrors.toArray();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      entity: 'mother',
      op: 'upsert',
      entity_id: M2,
      code: 'OUT_OF_SCOPE',
      message: 'change 1 out of scope',
    });
  });

  it('maps results by index when two entries share a mother id', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1, 'First Edit (synthetic)'), { clock });
    await saveMother(db, draft(M1, 'Second Edit (synthetic)'), { clock: () => NOW + 1000 });
    const f = scriptedFetch({ push: [pushReply('rejected', 'applied')] });

    await runCycle(makeDeps(db, f), signal());

    const errors = await db.syncErrors.toArray();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('change 0 out of scope');
    expect((errors[0].data as { full_name: string }).full_name).toBe('First Edit (synthetic)');
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the outbox and increments attempts on HTTP 5xx, without pulling', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    await setMeta(db, 'cursor', `${EPOCH}:7`);
    const f = scriptedFetch({ push: [errorReply(503, 'DB_BUSY', 'Database busy')] });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ phase: 'push', code: 'DB_BUSY', httpStatus: 503 });
    const outbox = await listOutbox(db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ attempts: 1, last_error: 'DB_BUSY' });
    expect(f.pulls()).toHaveLength(0);
    expect(await getCursor(db)).toBe(`${EPOCH}:7`);
    expect(await getMeta(db, 'lastSyncAt')).toBeUndefined();
  });

  it('keeps the outbox on a network error', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch({
      push: [
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ code: 'NETWORK_ERROR', httpStatus: null });
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 1, last_error: 'NETWORK_ERROR' });
  });

  it('times out a request after 10 s and keeps the outbox', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const t = manualTimers();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const f = scriptedFetch({ push: [hanging(() => started())] });

    const cycle = runCycle(makeDeps(db, f, { timers: t.timers }), signal());
    await fetchStarted;
    expect([...t.pending.values()].map((p) => p.ms)).toEqual([REQUEST_TIMEOUT_MS]);
    t.fireAll();
    const out = await cycle;

    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('TIMEOUT');
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 1, last_error: 'TIMEOUT' });
  });

  it('moves entries to syncErrors after 5 push attempts rejected with HTTP 422', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const invalid = reply(422, { detail: [{ loc: ['body', 'changes'], msg: 'Invalid envelope' }] });
    const f = scriptedFetch({ push: [invalid, invalid, invalid, invalid, invalid] });
    const deps = makeDeps(db, f);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await runCycle(deps, signal())).status).toBe('failed');
      expect((await listOutbox(db))[0]).toMatchObject({ attempts: attempt, last_error: 'VALIDATION_ERROR' });
      expect(await db.syncErrors.count()).toBe(0);
    }
    expect((await runCycle(deps, signal())).status).toBe('failed');

    expect(await db.outbox.count()).toBe(0);
    const errors = await db.syncErrors.toArray();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ entity_id: M1, code: 'VALIDATION_ERROR' });
    expect(f.pulls()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ auth failures

describe('401 and 403', () => {
  it('401 stops the cycle, leaves the outbox untouched and asks for sign-in', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch({ push: [errorReply(401, 'NOT_AUTHENTICATED')] });
    const onUnauthorized = vi.fn();
    const engine = new SyncEngine({
      ...makeDeps(db, f),
      timers: manualTimers().timers,
      eventTarget: null,
      subscribeWrites: () => () => undefined,
      onUnauthorized,
    });

    const out = await engine.syncNow();

    expect(out.status).toBe('unauthorized');
    expect(engine.getState().auth).toBe('needed');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 0, last_error: null });
    expect(f.pulls()).toHaveLength(0);
  });

  it('a missing token is unauthorized without any request', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch();

    const out = await runCycle(makeDeps(db, f, { getToken: () => null }), signal());

    expect(out.status).toBe('unauthorized');
    expect(f.calls).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
  });

  it('403 stops the cycle, shows "Not allowed" and logs to the console', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch({ push: [errorReply(403, 'FORBIDDEN')] });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const engine = new SyncEngine({
      ...makeDeps(db, f, { logger }),
      timers: manualTimers().timers,
      eventTarget: null,
      subscribeWrites: () => () => undefined,
    });

    const out = await engine.syncNow();

    expect(out.status).toBe('forbidden');
    expect(engine.getState().auth).toBe('forbidden');
    expect(logger.error).toHaveBeenCalled();
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 0 });
  });

  it('403 on pull is also forbidden', async () => {
    const db = freshDb();
    const f = scriptedFetch({ pull: [errorReply(403, 'FORBIDDEN')] });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('forbidden');
    expect(out.error?.phase).toBe('pull');
  });
});

// ------------------------------------------------------------------ pull merge

describe('runCycle pull merge', () => {
  it('writes the cursor only after the merge; a failed merge keeps the old cursor and rows', async () => {
    const db = freshDb();
    await db.mothers.put(serverMother(M1, { full_name: 'Old Name (synthetic)' }));
    await setMeta(db, 'cursor', `${EPOCH}:1`);
    const page = pullBody({ cursor: `${EPOCH}:9`, mothers: [serverMother(M1, { full_name: 'New Name (synthetic)' })] });
    const f = scriptedFetch({ pull: [reply(200, page), reply(200, page)] });

    const failed = await runCycle(
      makeDeps(db, f, {
        beforeCursorWrite: () => {
          throw new Error('injected merge failure');
        },
      }),
      signal(),
    );

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ phase: 'merge', code: 'MERGE_FAILED' });
    expect(await getCursor(db)).toBe(`${EPOCH}:1`);
    expect((await db.mothers.get(M1))?.full_name).toBe('Old Name (synthetic)');
    expect(await getMeta(db, 'lastSyncAt')).toBeUndefined();

    const ok = await runCycle(makeDeps(db, f), signal());

    expect(ok.status).toBe('ok');
    expect(f.pulls().map((c) => c.since)).toEqual([`${EPOCH}:1`, `${EPOCH}:1`]);
    expect(await getCursor(db)).toBe(`${EPOCH}:9`);
    expect((await db.mothers.get(M1))?.full_name).toBe('New Name (synthetic)');
  });

  it('keeps local fields of a pending mother and the done status of a pending task', async () => {
    const db = freshDb();
    await db.mothers.put(serverMother(M1));
    await db.mothers.put(serverMother(M2));
    await db.tasks.put(serverTask(T1, M1));
    const f = scriptedFetch({
      pull: [
        async () => {
          // A local edit and completion land after the push, while the pull is in flight.
          await saveMother(db, draft(M1, 'Local Edit (synthetic)'), { clock });
          await completeTask(db, T1, 'visited', { clock });
          return json(
            200,
            pullBody({
              mothers: [
                serverMother(M1, {
                  full_name: 'Server Name (synthetic)',
                  risk_level: 'RED',
                  risk_updated_at: '2025-03-01T05:00:00Z',
                  edd_date: '2025-07-09',
                  flags: [{ code: 'HB_SEVERE', severity: 'RED', reason: 'Hb 6.8 g/dL < 7.0' }],
                }),
                serverMother(M2, { full_name: 'Server M2 (synthetic)', risk_level: 'AMBER' }),
              ],
              tasks: [serverTask(T1, M1, { status: 'open' })],
            }),
          );
        },
      ],
    });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('ok');
    const m1 = await db.mothers.get(M1);
    expect(m1).toMatchObject({
      full_name: 'Local Edit (synthetic)',
      risk_level: 'RED',
      risk_updated_at: '2025-03-01T05:00:00Z',
      edd_date: '2025-07-09',
      status: 'active',
      pending: true,
    });
    expect(m1?.flags.map((fl) => fl.code)).toEqual(['HB_SEVERE']);
    const m2 = await db.mothers.get(M2);
    expect(m2).toMatchObject({ full_name: 'Server M2 (synthetic)', risk_level: 'AMBER' });
    expect(m2?.pending).toBeUndefined();
    expect(await db.tasks.get(T1)).toMatchObject({ status: 'done', done_note: 'visited', pending: true });
    expect(await db.outbox.count()).toBe(2);
  });

  it('on reset, deletes rows without pending work and keeps pending local work', async () => {
    const db = freshDb();
    await db.mothers.put(serverMother(M1));
    await db.mothers.put(serverMother(M2));
    await db.visits.put(serverVisit(V1, M1));
    await db.tasks.put(serverTask(T1, M1));
    const newcomer = '00000000-0000-4000-8000-0000000000a9';
    let localVisitId = '';
    const f = scriptedFetch({
      pull: [
        async () => {
          // Pending work queued while the reset pull is in flight.
          await saveMother(db, draft(M3, 'Brand New (synthetic)'), { clock });
          localVisitId = (await saveVisit(db, { mother_id: M2, visit_date: '2025-03-01', hb_gdl: 10.5, hb_source: 'manual' }, { clock })).id;
          return json(200, pullBody({ reset: true, cursor: `${EPOCH}:50`, mothers: [serverMother(newcomer)] }));
        },
      ],
    });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('ok');
    expect(out.pull).toMatchObject({ reset: true, recovered: false });
    expect(await db.mothers.get(M1)).toBeUndefined();
    expect(await db.visits.get(V1)).toBeUndefined();
    expect(await db.tasks.get(T1)).toBeUndefined();
    expect(await db.mothers.get(M2)).toBeDefined(); // mother of a pending visit
    expect(await db.mothers.get(M3)).toMatchObject({ pending: true });
    expect(await db.visits.get(localVisitId)).toMatchObject({ pending: true });
    expect(await db.mothers.get(newcomer)).toBeDefined();
    expect(await getCursor(db)).toBe(`${EPOCH}:50`);
  });

  it('INVALID_CURSOR resets the cursor, pulls once from "0" and merges as reset', async () => {
    const db = freshDb();
    await db.mothers.put(serverMother(M1));
    await setMeta(db, 'cursor', 'not-a-cursor');
    const f = scriptedFetch({
      pull: [
        errorReply(400, 'INVALID_CURSOR', 'Malformed cursor'),
        reply(200, pullBody({ reset: false, cursor: `${EPOCH}:3`, mothers: [serverMother(M2)] })),
      ],
    });
    const deps = makeDeps(db, f);

    const out = await runCycle(deps, signal());

    expect(out.status).toBe('ok');
    expect(out.pull).toMatchObject({ reset: true, recovered: true, mothers: 1 });
    expect(f.pulls().map((c) => c.since)).toEqual(['not-a-cursor', '0']);
    expect(await db.mothers.get(M1)).toBeUndefined();
    expect(await db.mothers.get(M2)).toBeDefined();
    expect(await getCursor(db)).toBe(`${EPOCH}:3`);
    expect(deps.logger?.warn).toHaveBeenCalled();
  });

  it('INVALID_CURSOR is retried only once', async () => {
    const db = freshDb();
    await setMeta(db, 'cursor', 'not-a-cursor');
    const bad = errorReply(400, 'INVALID_CURSOR', 'Malformed cursor');
    const f = scriptedFetch({ pull: [bad, bad] });

    const out = await runCycle(makeDeps(db, f), signal());

    expect(out.status).toBe('failed');
    expect(out.error).toMatchObject({ phase: 'pull', code: 'INVALID_CURSOR', httpStatus: 400 });
    expect(f.pulls()).toHaveLength(2);
    expect(await getCursor(db)).toBe('0');
  });
});

// ------------------------------------------------------------------ offline and single flight

describe('offline, abort and single flight', () => {
  it('skips the cycle without requests while simulated offline or offline', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch();

    const sim = await runCycle(makeDeps(db, f, { isSimOffline: () => true }), signal());
    const off = await runCycle(makeDeps(db, f, { isOnline: () => false }), signal());

    expect(sim).toMatchObject({ status: 'skipped', skipReason: 'simulatedOffline' });
    expect(off).toMatchObject({ status: 'skipped', skipReason: 'offline' });
    expect(f.calls).toHaveLength(0);
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 0 });
  });

  it('turning simulate-offline on aborts the in-flight request and keeps the outbox', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const f = scriptedFetch({ push: [hanging(() => started())] });
    const engine = new SyncEngine({
      ...makeDeps(db, f),
      timers: manualTimers().timers,
      eventTarget: null,
      subscribeWrites: () => () => undefined,
    });

    const cycle = engine.syncNow();
    await fetchStarted;
    engine.setSimulatedOffline(true);
    const out = await cycle;

    expect(out.status).toBe('aborted');
    expect(engine.getState()).toMatchObject({ simulatedOffline: true, syncing: false });
    expect((await listOutbox(db))[0]).toMatchObject({ attempts: 0, last_error: null });

    const again = await engine.syncNow();
    expect(again).toMatchObject({ status: 'skipped', skipReason: 'simulatedOffline' });
    expect(f.calls).toHaveLength(1);
  });

  it('runs one cycle at a time per database', async () => {
    const db = freshDb();
    await saveMother(db, draft(M1), { clock });
    const f = scriptedFetch();
    const deps = makeDeps(db, f);

    const first = runCycle(deps, signal());
    const second = await runCycle(deps, signal());
    expect(second).toMatchObject({ status: 'skipped', skipReason: 'busy' });
    expect((await first).status).toBe('ok');

    expect((await runCycle(deps, signal())).status).toBe('ok');
    expect(f.pushes()).toHaveLength(1);
  });
});
