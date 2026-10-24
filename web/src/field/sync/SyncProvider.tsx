/**
 * Sync context for the field area (Req 27.1–27.4, 28.1, 28.4, 37.5).
 *
 * Owns one `SyncEngine` per field database and exposes:
 * - the badge state (`deriveBadge`) and the inputs it was derived from;
 * - live pending and sync-error counts (and the error rows) through `useLiveQuery`;
 * - the persisted "Simulate offline" switch (`localStorage['maatriva.simOffline']`);
 * - `syncNow()` for the "Sync now" button.
 *
 * Auth: the engine reads the token through a ref. An expired token, or one the
 * server rejected with 401 (`markUnauthorized`), yields no token, so no request is
 * made and the badge shows "Sign in to sync" while local work continues (Req 37.5).
 * A new sign-in resets the engine's auth state and starts a cycle.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '../../shared/auth';
import type { FieldDb, SyncErrorEntry } from '../db';
import { listSyncErrors } from '../outbox';
import { deriveBadge, type BadgeState, type SyncStatus } from './badge';
import {
  createSyncEngine,
  readSimOffline,
  writeSimOffline,
  type CycleOutcome,
  type EngineState,
  type SyncEngine,
  type SyncEngineOptions,
} from './engine';

export interface SyncContextValue {
  db: FieldDb;
  badge: BadgeState;
  status: SyncStatus;
  pendingCount: number;
  syncErrorCount: number;
  /** Rejected changes, newest first (Req 28.3). */
  syncErrors: SyncErrorEntry[];
  simulatedOffline: boolean;
  setSimulatedOffline: (on: boolean) => void;
  toggleSimulatedOffline: () => void;
  syncNow: () => Promise<CycleOutcome | null>;
  lastOutcome: CycleOutcome | null;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export interface SyncProviderProps {
  db: FieldDb;
  children: ReactNode;
  /** Extra engine options (tests: fetch, timers, clock, eventTarget, locks). */
  engineOptions?: Partial<Omit<SyncEngineOptions, 'db' | 'getToken' | 'onUnauthorized' | 'simulatedOffline'>>;
}

const IDLE_STATE: EngineState = {
  online: true,
  simulatedOffline: false,
  syncing: false,
  auth: 'ok',
  lastCycleFailed: false,
  lastSyncAt: null,
  lastOutcome: null,
};

const noopSubscribe = () => () => {};

export function SyncProvider({ db, children, engineOptions }: SyncProviderProps) {
  const { token, tokenExpired, markUnauthorized } = useAuth();
  const [simulatedOffline, setSimState] = useState<boolean>(() => readSimOffline());
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  // Latest values for the engine's callbacks.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = tokenExpired ? null : token;
  const markRef = useRef(markUnauthorized);
  markRef.current = markUnauthorized;
  const simRef = useRef(simulatedOffline);
  const optionsRef = useRef(engineOptions);
  optionsRef.current = engineOptions;

  // One engine per database. StrictMode's double effect creates and discards a spare
  // one; starting a tick later means the spare never starts. (Started and stopped at
  // once, its aborted start cycle would still hold the single-flight flag, and the
  // real engine's start cycle would be skipped as `busy` until the 15 s interval.)
  useEffect(() => {
    const e = createSyncEngine({
      ...optionsRef.current,
      db,
      getToken: () => tokenRef.current,
      onUnauthorized: () => markRef.current(),
      simulatedOffline: simRef.current,
    });
    setEngine(e);
    const startId = setTimeout(() => e.start(), 0);
    return () => {
      clearTimeout(startId);
      e.stop();
      setEngine((cur) => (cur === e ? null : cur));
    };
  }, [db]);

  // A new usable token (fresh sign-in): forget the old 401/403 and sync.
  const usableToken = tokenExpired ? null : token;
  const lastTokenRef = useRef(usableToken);
  useEffect(() => {
    if (usableToken && usableToken !== lastTokenRef.current) engine?.resetAuth();
    lastTokenRef.current = usableToken;
  }, [usableToken, engine]);

  const engineState = useSyncExternalStore(
    engine ? engine.subscribe : noopSubscribe,
    engine ? engine.getState : () => IDLE_STATE,
    () => IDLE_STATE,
  );

  const pendingCount = useLiveQuery(() => db.outbox.count(), [db], 0);
  const syncErrorCount = useLiveQuery(() => db.syncErrors.count(), [db], 0);
  const syncErrors = useLiveQuery(() => listSyncErrors(db), [db], [] as SyncErrorEntry[]);

  const setSimulatedOffline = useCallback(
    (on: boolean) => {
      simRef.current = on;
      writeSimOffline(on);
      setSimState(on);
      engine?.setSimulatedOffline(on);
    },
    [engine],
  );

  const toggleSimulatedOffline = useCallback(() => setSimulatedOffline(!simRef.current), [setSimulatedOffline]);

  const syncNow = useCallback(async () => (engine ? engine.syncNow() : null), [engine]);

  const value = useMemo<SyncContextValue>(() => {
    const status: SyncStatus = {
      online: engineState.online,
      simulatedOffline,
      syncing: engineState.syncing,
      pendingCount,
      syncErrorCount,
      lastSyncAt: engineState.lastSyncAt,
      auth: tokenExpired || !token ? 'needed' : engineState.auth,
      lastCycleFailed: engineState.lastCycleFailed,
    };
    return {
      db,
      badge: deriveBadge(status),
      status,
      pendingCount,
      syncErrorCount,
      syncErrors,
      simulatedOffline,
      setSimulatedOffline,
      toggleSimulatedOffline,
      syncNow,
      lastOutcome: engineState.lastOutcome,
    };
  }, [
    db,
    engineState,
    simulatedOffline,
    pendingCount,
    syncErrorCount,
    syncErrors,
    token,
    tokenExpired,
    setSimulatedOffline,
    toggleSimulatedOffline,
    syncNow,
  ]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used inside <SyncProvider>');
  return ctx;
}
