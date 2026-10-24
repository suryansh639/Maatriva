/**
 * Live dashboard client (Req 19.1–19.7; design §17).
 *
 * Doctors (`role === 'doctor'`, Req 19.2):
 * - `GET /api/alerts/stream` is opened with `fetch` and `Authorization: Bearer`
 *   (EventSource cannot send headers). The body is read as a ReadableStream,
 *   decoded with a streaming TextDecoder and fed to `createSseParser`, so frames
 *   split across chunks are handled (Req 19.1).
 * - When the stream ends or errors it reconnects after `backoffDelay(attempt)`
 *   (1, 2, 5, 10, 10… s). A `hello` event resets the attempt counter (Req 19.4).
 * - On every `hello` (connect and reconnect) the hook fetches the open alerts and
 *   fires a `'connected'` refetch so the page reloads census and queue (Req 19.5).
 * - While not live it polls `GET /api/alerts?status=open` every 15 s (Req 19.6).
 * - A 401 (stream or poll) clears the session and navigates to `/login`, with no
 *   further reconnects (Req 19.7). A 403 stops the stream.
 * - Unmount, logout or a token change aborts the request and all timers.
 *
 * ANMs get no SSE: the hook fires an `'interval'` refetch every 30 s (Req 19.3).
 *
 * Consumers receive typed events through the `onEvent` option and/or
 * `subscribe(listener)`; refetch triggers through `onRefetch` and/or the
 * `refetchTick` counter (handy as a `useEffect` dependency).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders, isApiError, toApiError } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { LOGIN_PATH } from '../../shared/routes';
import type { AlertOut, LiveEventMap, LiveEventName } from '../../shared/types';
import { ALERT_STREAM_PATH, listAlerts } from '../doctorApi';
import { backoffDelay } from './backoff';
import { createSseParser } from './sseParser';
import type { SseEvent } from './sseParser';

/** Poll interval for open alerts while the stream is down (Req 19.6). */
export const DISCONNECTED_POLL_MS = 15_000;
/** ANM census/queue refetch interval (Req 19.3). */
export const ANM_REFETCH_MS = 30_000;

export const LIVE_EVENT_NAMES: readonly LiveEventName[] = [
  'hello',
  'alert.created',
  'alert.updated',
  'task.done',
  'risk.changed',
];

/** A typed live event: a discriminated union on `type`. */
export type LiveEvent = {
  [K in LiveEventName]: { type: K; data: LiveEventMap[K]; id: string };
}[LiveEventName];

export type LiveListener = (event: LiveEvent) => void;

/**
 * - `idle`: no stream for this user (ANM, disabled, signed out)
 * - `connecting`: first connection attempt
 * - `live`: `hello` received on the current connection
 * - `reconnecting`: the stream dropped; waiting for or making the next attempt
 * - `offline`: the browser is offline, or the stream was refused (403)
 */
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

export type LiveMode = 'sse' | 'poll' | 'none';

/** Why a refetch was requested: a (re)connect `hello`, or the ANM 30 s tick. */
export type RefetchReason = 'connected' | 'interval';

function isKnownEvent(name: string): name is LiveEventName {
  return (LIVE_EVENT_NAMES as readonly string[]).includes(name);
}

/** Map a parsed SSE frame to a typed event; null for unknown names or non-object JSON. */
export function toLiveEvent(frame: SseEvent): LiveEvent | null {
  if (!isKnownEvent(frame.event)) return null;
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return { type: frame.event, data, id: frame.id } as LiveEvent;
}

/** How one stream connection finished without throwing. */
export type StreamEnd = 'ended' | 'unauthorized' | 'forbidden';

export interface RunLiveStreamOptions {
  token: string;
  signal: AbortSignal;
  onEvent: LiveListener;
  fetchImpl?: typeof fetch;
}

/**
 * Open the SSE stream once and read it to the end. Resolves `'ended'` when the
 * server closes the body, `'unauthorized'` on 401 and `'forbidden'` on 403.
 * Throws on network errors, aborts and other HTTP errors (as `ApiError`).
 */
export async function runLiveStream({ token, signal, onEvent, fetchImpl }: RunLiveStreamOptions): Promise<StreamEnd> {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(ALERT_STREAM_PATH, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', ...authHeaders(token) },
    cache: 'no-store',
    signal,
  });
  if (res.status === 401) return 'unauthorized';
  if (res.status === 403) return 'forbidden';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body: unknown = text || null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // keep the raw text
    }
    throw toApiError(res.status, body);
  }
  if (!res.body) throw new Error('SSE response has no body');

  const parser = createSseParser((frame) => {
    const ev = toLiveEvent(frame);
    if (ev) onEvent(ev);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    return 'ended';
  } finally {
    parser.end();
    reader.cancel().catch(() => undefined);
  }
}

export interface UseLiveEventsOptions {
  /** Default true. False behaves like a user without live updates (`mode: 'none'`). */
  enabled?: boolean;
  /** Called for every typed event, before `subscribe` listeners. */
  onEvent?: LiveListener;
  /** Doctor: after each `hello`. ANM: every 30 s. Refetch census and queue here. */
  onRefetch?: (reason: RefetchReason) => void;
  /** Open RED alerts, fetched on each `hello` and every 15 s while disconnected. */
  onOpenAlerts?: (alerts: AlertOut[]) => void;
}

export interface LiveEventsState {
  mode: LiveMode;
  status: LiveStatus;
  /** True while the stream is `live`. */
  connected: boolean;
  /** Increments on every refetch trigger (`onRefetch`). */
  refetchTick: number;
  /** Latest open alerts from the hook's own fetches; null before the first one. */
  openAlerts: AlertOut[] | null;
  /** Add a listener for typed events; returns the unsubscribe function. */
  subscribe: (listener: LiveListener) => () => void;
}

export function useLiveEvents(options: UseLiveEventsOptions = {}): LiveEventsState {
  const { enabled = true } = options;
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();

  const role = user?.role;
  const mode: LiveMode = !enabled || !token ? 'none' : role === 'doctor' ? 'sse' : role === 'anm' ? 'poll' : 'none';

  const [rawStatus, setRawStatus] = useState<LiveStatus>('connecting');
  const [refetchTick, setRefetchTick] = useState(0);
  const [openAlerts, setOpenAlerts] = useState<AlertOut[] | null>(null);
  const status: LiveStatus = mode === 'sse' ? rawStatus : 'idle';

  // Latest callbacks, so changing them never reconnects the stream.
  const onEventRef = useRef(options.onEvent);
  const onRefetchRef = useRef(options.onRefetch);
  const onOpenAlertsRef = useRef(options.onOpenAlerts);
  onEventRef.current = options.onEvent;
  onRefetchRef.current = options.onRefetch;
  onOpenAlertsRef.current = options.onOpenAlerts;

  const listenersRef = useRef(new Set<LiveListener>());

  const subscribe = useCallback((listener: LiveListener) => {
    const listeners = listenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dispatch = useCallback((ev: LiveEvent) => {
    const all: LiveListener[] = [];
    if (onEventRef.current) all.push(onEventRef.current);
    all.push(...listenersRef.current);
    for (const listener of all) {
      try {
        listener(ev);
      } catch (err) {
        console.error('live event listener failed', ev.type, err);
      }
    }
  }, []);

  const handleUnauthorizedRef = useRef<() => void>(() => undefined);
  handleUnauthorizedRef.current = () => {
    logout();
    navigate(LOGIN_PATH, { replace: true });
  };

  const fetchOpenAlerts = useCallback(async (signal: AbortSignal) => {
    try {
      const alerts = await listAlerts('open', signal);
      if (signal.aborted) return;
      setOpenAlerts(alerts);
      onOpenAlertsRef.current?.(alerts);
    } catch (err) {
      if (signal.aborted) return;
      if (isApiError(err) && err.status === 401) {
        handleUnauthorizedRef.current();
        return;
      }
      console.warn('open alerts fetch failed', isApiError(err) ? err.code : err);
    }
  }, []);

  // Doctor: the SSE connection loop.
  useEffect(() => {
    if (mode !== 'sse' || !token) return;
    const ctrl = new AbortController();
    const { signal } = ctrl;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wakeUp: (() => void) | undefined;

    const setStatus = (s: LiveStatus) => {
      if (!signal.aborted) setRawStatus(s);
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wakeUp = resolve;
        timer = setTimeout(resolve, ms);
      });
    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      wakeUp?.();
    };
    // Coming back online skips the rest of the backoff wait.
    window.addEventListener('online', wake);
    signal.addEventListener('abort', wake);

    const onStreamEvent = (ev: LiveEvent) => {
      if (signal.aborted) return;
      if (ev.type === 'hello') {
        attempt = 0;
        setStatus('live');
        setRefetchTick((t) => t + 1);
        onRefetchRef.current?.('connected');
        void fetchOpenAlerts(signal);
      }
      dispatch(ev);
    };

    void (async () => {
      let first = true;
      while (!signal.aborted) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setStatus('offline');
        } else {
          setStatus(first ? 'connecting' : 'reconnecting');
          first = false;
          let end: StreamEnd = 'ended';
          try {
            end = await runLiveStream({ token, signal, onEvent: onStreamEvent });
          } catch (err) {
            if (signal.aborted) return;
            console.warn('live stream dropped', isApiError(err) ? err.code : err);
          }
          if (signal.aborted) return;
          if (end === 'unauthorized') {
            handleUnauthorizedRef.current();
            return;
          }
          if (end === 'forbidden') {
            console.warn('live stream not allowed for this user');
            setStatus('offline');
            return;
          }
          setStatus('reconnecting');
        }
        await sleep(backoffDelay(attempt));
        attempt += 1;
      }
    })();

    return () => {
      ctrl.abort();
      window.removeEventListener('online', wake);
      if (timer !== undefined) clearTimeout(timer);
      setRawStatus('connecting');
    };
  }, [mode, token, dispatch, fetchOpenAlerts]);

  // Doctor: poll open alerts every 15 s while the stream is not live.
  const disconnected = mode === 'sse' && status !== 'live';
  useEffect(() => {
    if (!disconnected) return;
    const ctrl = new AbortController();
    const id = setInterval(() => void fetchOpenAlerts(ctrl.signal), DISCONNECTED_POLL_MS);
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [disconnected, token, fetchOpenAlerts]);

  // ANM: refetch census and queue every 30 s.
  useEffect(() => {
    if (mode !== 'poll') return;
    const id = setInterval(() => {
      setRefetchTick((t) => t + 1);
      onRefetchRef.current?.('interval');
    }, ANM_REFETCH_MS);
    return () => clearInterval(id);
  }, [mode]);

  return {
    mode,
    status,
    connected: status === 'live',
    refetchTick,
    openAlerts,
    subscribe,
  };
}
