/**
 * Field sync engine (Req 27.1–27.15, 37.5; design §16).
 *
 * `runCycle(deps, signal)` runs ONE sync cycle:
 *   1. skip when the device is offline or "Simulate offline" is on (Req 27.3);
 *   2. push the outbox in ascending `seq` order, in batches of up to 100, until it is
 *      empty (Req 27.5), mapping `results[i]` to the i-th entry sent (Req 27.7–27.9);
 *   3. pull from the stored cursor and merge in one Dexie transaction, cursor written
 *      last (Req 27.15), then record `lastSyncAt`.
 *
 * Failure handling (Req 27.10–27.14):
 *   - network error, timeout (10 s per request) or 5xx: stop, keep the outbox, and
 *     increment the attempts of the batch that was being pushed;
 *   - 401: stop, keep the outbox untouched → badge "Sign in to sync";
 *   - 403: stop → badge "Not allowed", logged to the console;
 *   - push 400/422: increment the batch's attempts; entries reaching 5 move to
 *     `syncErrors`;
 *   - pull 400 `INVALID_CURSOR`: reset the cursor to "0", pull once more, and merge
 *     that pull as `reset: true`.
 *
 * Cycles are single-flight: through Web Locks (`ifAvailable`, so a second tab skips
 * instead of queueing) when available, otherwise an in-module flag.
 *
 * `SyncEngine` owns the triggers (Req 27.1): start, the `online` event, turning
 * simulate-offline off, a 15 s interval, 500 ms after the last local write, and
 * "Sync now". Turning simulate-offline on aborts the in-flight request (Req 27.4).
 * Fetch, clock, timers, locks and the event target are injectable for tests.
 */

import { apiFetch, isApiError } from '../../shared/api';
import { nowIsoZ, systemClock, type Clock } from '../../shared/time';
import type { PullResponse, PushRequest, PushResponse } from '../../shared/types';
import { getCursor, getDeviceId, getMeta, setMeta, type FieldDb, type OutboxEntry } from '../db';
import { listOutbox, onLocalWrite } from '../outbox';
import type { AuthState } from './badge';
import {
  MAX_ATTEMPTS,
  applyBatchPlan,
  applyPullMerge,
  mapResults,
  planBatchFailure,
  type BatchPlan,
} from './merge';

// ------------------------------------------------------------------ constants

/** Outbox entries per push request (Req 27.5; the server accepts up to 200). */
export const PUSH_BATCH_SIZE = 100;
/** Per-request timeout (Req 27.6). */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Periodic trigger (Req 27.1). */
export const SYNC_INTERVAL_MS = 15_000;
/** Debounce after the last local write (Req 27.1). */
export const WRITE_DEBOUNCE_MS = 500;
/** `localStorage` key of the simulate-offline switch (Req 28.4). */
export const SIM_OFFLINE_KEY = 'maatriva.simOffline';

export const PUSH_PATH = '/api/sync/push';
export const PULL_PATH = '/api/sync/pull';

// ------------------------------------------------------------------ types

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface IntervalApi extends TimerApi {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

/** The subset of the Web Locks API used here. */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export interface SyncDeps {
  db: FieldDb;
  /** Bearer token; null means "not signed in / expired" and no request is made. */
  getToken: () => string | null;
  fetch?: typeof fetch;
  clock?: Clock;
  isOnline?: () => boolean;
  isSimOffline?: () => boolean;
  timers?: TimerApi;
  /** Web Locks manager; `null` forces the in-module flag. Defaults to `navigator.locks`. */
  locks?: LockManagerLike | null;
  timeoutMs?: number;
  batchSize?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
  /** Passed to `applyPullMerge` (tests inject a failure before the cursor write). */
  beforeCursorWrite?: () => void | Promise<void>;
}

export type CycleStatus = 'ok' | 'skipped' | 'aborted' | 'failed' | 'unauthorized' | 'forbidden';
export type SkipReason = 'offline' | 'simulatedOffline' | 'busy' | 'stopped';

export interface CycleError {
  phase: 'push' | 'pull' | 'merge';
  code: string;
  message: string;
  /** HTTP status, or null for network errors, timeouts and local failures. */
  httpStatus: number | null;
}

export interface PullSummary {
  reset: boolean;
  /** True when this pull was the INVALID_CURSOR recovery pull (Req 27.14). */
  recovered: boolean;
  mothers: number;
  visits: number;
  tasks: number;
}

export interface CycleOutcome {
  status: CycleStatus;
  skipReason?: SkipReason;
  error?: CycleError;
  /** Push requests sent this cycle. */
  batches: number;
  /** Outbox entries removed because the server applied/deduplicated/staled them. */
  settled: number;
  /** Outbox entries moved to `syncErrors` this cycle. */
  rejected: number;
  pull: PullSummary | null;
  /** `lastSyncAt` written by this cycle (status `ok` only). */
  lastSyncAt: string | null;
}

function outcome(status: CycleStatus, extra: Partial<CycleOutcome> = {}): CycleOutcome {
  return { status, batches: 0, settled: 0, rejected: 0, pull: null, lastSyncAt: null, ...extra };
}

// ------------------------------------------------------------------ environment defaults

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean' ? true : navigator.onLine;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

const defaultTimers: IntervalApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
};

// ------------------------------------------------------------------ simulate-offline storage

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The persisted simulate-offline switch (Req 28.4); false when unset. */
export function readSimOffline(store: Pick<Storage, 'getItem'> | undefined = storage()): boolean {
  try {
    return store?.getItem(SIM_OFFLINE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSimOffline(on: boolean, store: Pick<Storage, 'setItem'> | undefined = storage()): void {
  try {
    store?.setItem(SIM_OFFLINE_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the switch lasts for this page only.
  }
}

// ------------------------------------------------------------------ requests

type FailureKind = 'aborted' | 'timeout' | 'network' | 'http';

/** A failed request, classified for the failure table. */
export class RequestFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly code: string;

  constructor(kind: FailureKind, code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'RequestFailure';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

interface RequestCtx {
  fetchImpl: typeof fetch;
  token: string;
  timers: TimerApi;
  timeoutMs: number;
  cycle: AbortSignal;
}

/**
 * One API call with its own timeout, also aborted by the cycle signal. The call is
 * raced against the abort, so even a fetch that ignores its signal cannot hang a cycle.
 */
async function request<T>(
  ctx: RequestCtx,
  path: string,
  opts: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  if (ctx.cycle.aborted) throw new RequestFailure('aborted', 'ABORTED', 'Sync aborted');
  const ctl = new AbortController();
  let timedOut = false;
  const onCycleAbort = () => ctl.abort(ctx.cycle.reason);
  ctx.cycle.addEventListener('abort', onCycleAbort, { once: true });
  const timer = ctx.timers.setTimeout(() => {
    timedOut = true;
    ctl.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, ctx.timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener(
      'abort',
      () =>
        reject(
          timedOut
            ? new RequestFailure('timeout', 'TIMEOUT', `No response within ${ctx.timeoutMs} ms`)
            : new RequestFailure('aborted', 'ABORTED', 'Sync aborted'),
        ),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      apiFetch<T>(path, {
        method: opts.method,
        body: opts.body,
        query: opts.query,
        token: ctx.token,
        signal: ctl.signal,
        fetchImpl: ctx.fetchImpl,
      }),
      aborted,
    ]);
  } catch (err) {
    if (err instanceof RequestFailure) throw err;
    if (isApiError(err)) throw new RequestFailure('http', err.code, err.message, err.status);
    if (timedOut) throw new RequestFailure('timeout', 'TIMEOUT', `No response within ${ctx.timeoutMs} ms`);
    if (ctx.cycle.aborted) throw new RequestFailure('aborted', 'ABORTED', 'Sync aborted');
    const message = err instanceof Error && err.message ? err.message : 'Network error';
    throw new RequestFailure('network', 'NETWORK_ERROR', message);
  } finally {
    ctx.timers.clearTimeout(timer);
    ctx.cycle.removeEventListener('abort', onCycleAbort);
  }
}

/** Map a request failure to a terminal cycle outcome (Req 27.10–27.12). */
function failureOutcome(
  f: RequestFailure,
  phase: CycleError['phase'],
  progress: Partial<CycleOutcome>,
  logger: Pick<Console, 'warn' | 'error'>,
): CycleOutcome {
  const error: CycleError = { phase, code: f.code, message: f.message, httpStatus: f.status };
  if (f.kind === 'aborted') return outcome('aborted', { ...progress, error });
  if (f.status === 401) return outcome('unauthorized', { ...progress, error });
  if (f.status === 403) {
    logger.error(`sync ${phase} forbidden (HTTP 403): ${f.code}`);
    return outcome('forbidden', { ...progress, error });
  }
  return outcome('failed', { ...progress, error });
}

function isPullResponse(value: unknown): value is PullResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.cursor === 'string' &&
    typeof v.reset === 'boolean' &&
    Array.isArray(v.villages) &&
    Array.isArray(v.mothers) &&
    Array.isArray(v.visits) &&
    Array.isArray(v.tasks)
  );
}

// ------------------------------------------------------------------ single flight

const localFlags = new Set<string>();

/** Run `fn` unless another cycle for the same database holds the lock (then: `busy`). */
async function exclusive(
  name: string,
  locks: LockManagerLike | null,
  fn: () => Promise<CycleOutcome>,
): Promise<CycleOutcome> {
  if (localFlags.has(name)) return outcome('skipped', { skipReason: 'busy' });
  localFlags.add(name);
  try {
    if (!locks) return await fn();
    return await locks.request(name, { ifAvailable: true }, async (lock) =>
      lock ? fn() : outcome('skipped', { skipReason: 'busy' }),
    );
  } finally {
    localFlags.delete(name);
  }
}

// ------------------------------------------------------------------ the cycle

/** Run one sync cycle (module docstring). Never throws for network or HTTP failures. */
export function runCycle(deps: SyncDeps, signal: AbortSignal): Promise<CycleOutcome> {
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const isSimOffline = deps.isSimOffline ?? (() => false);
  if (isSimOffline()) return Promise.resolve(outcome('skipped', { skipReason: 'simulatedOffline' }));
  if (!isOnline()) return Promise.resolve(outcome('skipped', { skipReason: 'offline' }));
  const locks = deps.locks === undefined ? defaultLocks() : deps.locks;
  return exclusive(`maatriva-sync:${deps.db.name}`, locks, () => cycleBody(deps, signal));
}

async function cycleBody(deps: SyncDeps, signal: AbortSignal): Promise<CycleOutcome> {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? console;
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const isSimOffline = deps.isSimOffline ?? (() => false);
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? PUSH_BATCH_SIZE, 200));

  const token = deps.getToken();
  if (!token) {
    return outcome('unauthorized', {
      error: { phase: 'push', code: 'NOT_AUTHENTICATED', message: 'No valid session token', httpStatus: null },
    });
  }
  const ctx: RequestCtx = {
    fetchImpl: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    token,
    timers: deps.timers ?? defaultTimers,
    timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    cycle: signal,
  };
  const progress = { batches: 0, settled: 0, rejected: 0 };
  const stillAllowed = (): CycleOutcome | null => {
    if (signal.aborted) return outcome('aborted', { ...progress });
    if (isSimOffline()) return outcome('skipped', { ...progress, skipReason: 'simulatedOffline' });
    if (!isOnline()) return outcome('skipped', { ...progress, skipReason: 'offline' });
    return null;
  };

  // ---- push: ascending seq, batches of `batchSize`, until the outbox is empty
  for (;;) {
    const stop = stillAllowed();
    if (stop) return stop;
    const batch = await listOutbox(db, batchSize);
    if (batch.length === 0) break;

    const body: PushRequest = {
      device_id: await getDeviceId(db),
      changes: batch.map(({ entity, op, data }) => ({ entity, op, data }) as PushRequest['changes'][number]),
    };
    progress.batches += 1;
    let res: PushResponse;
    try {
      res = await request<PushResponse>(ctx, PUSH_PATH, { method: 'POST', body });
    } catch (err) {
      const f = err instanceof RequestFailure ? err : new RequestFailure('network', 'NETWORK_ERROR', String(err));
      await recordPushFailure(db, batch, f, clock);
      return failureOutcome(f, 'push', progress, logger);
    }

    const results = res && Array.isArray(res.results) ? res.results : [];
    const plan = mapResults(batch, results, nowIsoZ(clock));
    await applyBatchPlan(db, plan);
    progress.settled += plan.deleteSeqs.length - plan.toSyncErrors.length;
    progress.rejected += plan.toSyncErrors.length;
    if (plan.keep.length > 0) {
      // Length mismatch or an unknown status: do not resend in a tight loop.
      const code = plan.keep[0].last_error ?? 'BAD_RESPONSE';
      return outcome('failed', {
        ...progress,
        error: { phase: 'push', code, message: 'Unexpected push response', httpStatus: null },
      });
    }
  }

  // ---- pull from the stored cursor; INVALID_CURSOR → one recovery pull from "0"
  let recovered = false;
  let pull: PullResponse | null = null;
  for (;;) {
    const stop = stillAllowed();
    if (stop) return stop;
    const since = recovered ? '0' : await getCursor(db);
    try {
      const res = await request<unknown>(ctx, PULL_PATH, { method: 'GET', query: { since } });
      if (!isPullResponse(res)) {
        return outcome('failed', {
          ...progress,
          error: { phase: 'pull', code: 'BAD_RESPONSE', message: 'Unexpected pull response', httpStatus: null },
        });
      }
      pull = res;
      break;
    } catch (err) {
      const f = err instanceof RequestFailure ? err : new RequestFailure('network', 'NETWORK_ERROR', String(err));
      if (!recovered && f.kind === 'http' && f.status === 400 && f.code === 'INVALID_CURSOR') {
        logger.warn('sync pull: INVALID_CURSOR, resetting the cursor and pulling a full snapshot');
        await setMeta(db, 'cursor', '0');
        recovered = true;
        continue;
      }
      return failureOutcome(f, 'pull', progress, logger);
    }
  }

  // ---- merge in one transaction, cursor last; then lastSyncAt
  try {
    await applyPullMerge(db, pull, { forceReset: recovered, beforeCursorWrite: deps.beforeCursorWrite });
  } catch (err) {
    logger.error('sync pull merge failed; cursor not advanced', err);
    return outcome('failed', {
      ...progress,
      error: {
        phase: 'merge',
        code: 'MERGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        httpStatus: null,
      },
    });
  }
  const lastSyncAt = nowIsoZ(clock);
  await setMeta(db, 'lastSyncAt', lastSyncAt);
  return outcome('ok', {
    ...progress,
    pull: {
      reset: pull.reset || recovered,
      recovered,
      mothers: pull.mothers.length,
      visits: pull.visits.length,
      tasks: pull.tasks.length,
    },
    lastSyncAt,
  });
}

/**
 * Outbox bookkeeping after a failed push request:
 * - network, timeout, 5xx and other unexpected statuses: attempts++, entries kept;
 * - 400/422: attempts++, entries reaching `MAX_ATTEMPTS` move to `syncErrors`;
 * - 401/403 and aborts: the outbox is left untouched.
 */
async function recordPushFailure(db: FieldDb, batch: OutboxEntry[], f: RequestFailure, clock: Clock): Promise<void> {
  if (f.kind === 'aborted' || f.status === 401 || f.status === 403) return;
  const moveAt = f.status === 400 || f.status === 422 ? MAX_ATTEMPTS : undefined;
  const plan: BatchPlan = planBatchFailure(batch, f.code, f.message, { moveAt, nowIso: nowIsoZ(clock) });
  await applyBatchPlan(db, plan);
}

// ------------------------------------------------------------------ engine (triggers + state)

export interface EngineState {
  online: boolean;
  simulatedOffline: boolean;
  syncing: boolean;
  auth: AuthState;
  lastCycleFailed: boolean;
  lastSyncAt: string | null;
  lastOutcome: CycleOutcome | null;
}

export type TriggerReason = 'start' | 'online' | 'simOff' | 'interval' | 'write' | 'manual' | 'auth';

export interface SyncEngineOptions extends Omit<SyncDeps, 'isSimOffline' | 'timers'> {
  timers?: IntervalApi;
  /** Initial simulate-offline state (the provider reads `localStorage`). */
  simulatedOffline?: boolean;
  intervalMs?: number;
  debounceMs?: number;
  /** Receives `online`/`offline` events; defaults to `window`. `null` disables. */
  eventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** Subscribe to local writes; defaults to `outbox.onLocalWrite`. */
  subscribeWrites?: (listener: () => void) => () => void;
  /** Called after a 401 (the auth context's `markUnauthorized`, Req 37.5). */
  onUnauthorized?: () => void;
}

export class SyncEngine {
  private readonly opts: SyncEngineOptions;
  private readonly timers: IntervalApi;
  private state: EngineState;
  private readonly listeners = new Set<() => void>();
  private running: Promise<CycleOutcome> | null = null;
  private rerun = false;
  private abort: AbortController | null = null;
  private started = false;
  private intervalId: unknown = null;
  private debounceId: unknown = null;
  private cleanups: (() => void)[] = [];

  constructor(opts: SyncEngineOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers;
    this.state = {
      online: (opts.isOnline ?? defaultIsOnline)(),
      simulatedOffline: opts.simulatedOffline ?? false,
      syncing: false,
      auth: 'ok',
      lastCycleFailed: false,
      lastSyncAt: null,
      lastOutcome: null,
    };
  }

  // ---- state

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<EngineState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof EngineState)[]).some((k) => next[k] !== this.state[k]);
    if (!changed) return;
    this.state = next;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.warn('sync state listener failed', err);
      }
    }
  }

  private isOnline(): boolean {
    return (this.opts.isOnline ?? defaultIsOnline)();
  }

  // ---- lifecycle

  /** Install the triggers and run the start cycle. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void getMeta(this.opts.db, 'lastSyncAt')
      .then((at) => {
        if (at && !this.state.lastSyncAt) this.setState({ lastSyncAt: at });
      })
      .catch((err) => console.warn('could not read lastSyncAt', err));

    const target = this.opts.eventTarget === undefined ? (typeof window === 'undefined' ? null : window) : this.opts.eventTarget;
    if (target) {
      const onOnline = () => {
        this.setState({ online: this.isOnline() });
        void this.trigger('online');
      };
      const onOffline = () => this.setState({ online: this.isOnline() });
      target.addEventListener('online', onOnline);
      target.addEventListener('offline', onOffline);
      this.cleanups.push(() => {
        target.removeEventListener('online', onOnline);
        target.removeEventListener('offline', onOffline);
      });
    }
    const subscribeWrites = this.opts.subscribeWrites ?? onLocalWrite;
    this.cleanups.push(subscribeWrites(() => this.scheduleAfterWrite()));
    this.intervalId = this.timers.setInterval(() => void this.trigger('interval'), this.opts.intervalMs ?? SYNC_INTERVAL_MS);
    void this.trigger('start');
  }

  /** Remove the triggers and abort any in-flight request. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const c of this.cleanups.splice(0)) c();
    if (this.intervalId !== null) this.timers.clearInterval(this.intervalId);
    if (this.debounceId !== null) this.timers.clearTimeout(this.debounceId);
    this.intervalId = null;
    this.debounceId = null;
    this.rerun = false;
    this.abort?.abort(new DOMException('Sync stopped', 'AbortError'));
  }

  private scheduleAfterWrite(): void {
    if (!this.started) return;
    if (this.debounceId !== null) this.timers.clearTimeout(this.debounceId);
    this.debounceId = this.timers.setTimeout(() => {
      this.debounceId = null;
      void this.trigger('write');
    }, this.opts.debounceMs ?? WRITE_DEBOUNCE_MS);
  }

  // ---- controls

  /** The "Sync now" button. */
  syncNow(): Promise<CycleOutcome> {
    return this.trigger('manual');
  }

  /** Turning on aborts the in-flight request (Req 27.4); turning off starts a cycle. */
  setSimulatedOffline(on: boolean): void {
    if (on === this.state.simulatedOffline) return;
    this.setState({ simulatedOffline: on });
    if (on) {
      this.rerun = false;
      this.abort?.abort(new DOMException('Simulated offline', 'AbortError'));
    } else {
      void this.trigger('simOff');
    }
  }

  /** After a new sign-in: forget the 401/403 state and sync. */
  resetAuth(): void {
    this.setState({ auth: 'ok' });
    if (this.started) void this.trigger('auth');
  }

  /**
   * Start a cycle now. While one runs, the request is coalesced: the running cycle's
   * promise is returned and one more cycle follows it if that one succeeded.
   */
  trigger(reason: TriggerReason): Promise<CycleOutcome> {
    this.setState({ online: this.isOnline() });
    if (!this.started && reason !== 'manual') return Promise.resolve(outcome('skipped', { skipReason: 'stopped' }));
    if (this.state.simulatedOffline) return Promise.resolve(outcome('skipped', { skipReason: 'simulatedOffline' }));
    if (!this.state.online) return Promise.resolve(outcome('skipped', { skipReason: 'offline' }));
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<CycleOutcome> {
    let result: CycleOutcome;
    do {
      this.rerun = false;
      const ctl = new AbortController();
      this.abort = ctl;
      this.setState({ syncing: true });
      try {
        result = await runCycle(
          {
            ...this.opts,
            timers: this.timers,
            isSimOffline: () => this.state.simulatedOffline,
          },
          ctl.signal,
        );
      } catch (err) {
        // Local (Dexie) failures outside the merge; keep the engine alive.
        console.error('sync cycle failed', err);
        result = outcome('failed', {
          error: {
            phase: 'push',
            code: 'LOCAL_ERROR',
            message: err instanceof Error ? err.message : String(err),
            httpStatus: null,
          },
        });
      } finally {
        if (this.abort === ctl) this.abort = null;
      }
      this.applyOutcome(result);
    } while (this.rerun && result.status === 'ok' && this.started && !this.state.simulatedOffline);
    return result;
  }

  private applyOutcome(o: CycleOutcome): void {
    const patch: Partial<EngineState> = { syncing: false, lastOutcome: o, online: this.isOnline() };
    switch (o.status) {
      case 'ok':
        patch.auth = 'ok';
        patch.lastCycleFailed = false;
        patch.lastSyncAt = o.lastSyncAt ?? this.state.lastSyncAt;
        break;
      case 'failed':
        patch.lastCycleFailed = true;
        break;
      case 'unauthorized':
        patch.auth = 'needed';
        break;
      case 'forbidden':
        patch.auth = 'forbidden';
        break;
      default:
        break;
    }
    this.setState(patch);
    if (o.status === 'unauthorized') this.opts.onUnauthorized?.();
  }
}

export function createSyncEngine(opts: SyncEngineOptions): SyncEngine {
  return new SyncEngine(opts);
}
