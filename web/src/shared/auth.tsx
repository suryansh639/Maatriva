/**
 * Client session (Req 37.1, 37.5).
 *
 * - The token and user are cached in `localStorage['maatriva.session']`.
 * - Field tokens are long-lived (backend TTL), and an ASHA with an expired token keeps
 *   working locally; `tokenExpired` lets the field area show "Sign in to sync".
 * - `apiFetch` gets the current bearer token through `setTokenGetter`, registered
 *   when this module loads, so it works before any React effect has run.
 * - Logging out only clears the session. It never deletes the field Dexie database
 *   (Req 37.7); the pending-outbox warning lives in the field area.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch, setTokenGetter } from './api';
import type { LoginResponse, Role, UserOut } from './types';

export const SESSION_STORAGE_KEY = 'maatriva.session';

export interface Session {
  token: string;
  /** UTC ISO-8601 expiry from the login response. */
  expiresAt: string;
  user: UserOut;
}

const ROLES: readonly Role[] = ['asha', 'anm', 'doctor', 'admin'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUser(value: unknown): value is UserOut {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.full_name === 'string' &&
    typeof value.role === 'string' &&
    (ROLES as readonly string[]).includes(value.role) &&
    (value.facility_id === null || typeof value.facility_id === 'string') &&
    (value.facility_name === null || typeof value.facility_name === 'string') &&
    Array.isArray(value.village_ids) &&
    value.village_ids.every((v) => typeof v === 'string')
  );
}

/** Parse a stored session; null when missing or malformed. */
export function parseSession(raw: string | null | undefined): Session | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.token === 'string' &&
      value.token.length > 0 &&
      typeof value.expiresAt === 'string' &&
      isUser(value.user)
    ) {
      return { token: value.token, expiresAt: value.expiresAt, user: value.user };
    }
  } catch {
    // Corrupt JSON is treated as "no session".
  }
  return null;
}

export function sessionFromLogin(res: LoginResponse): Session {
  return { token: res.access_token, expiresAt: res.expires_at, user: res.user };
}

/** True when the token's expiry has passed (or cannot be parsed). */
export function isSessionExpired(session: Session, nowMs: number = Date.now()): boolean {
  const exp = Date.parse(session.expiresAt);
  return Number.isNaN(exp) || exp <= nowMs;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSession(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Session | null {
  try {
    return parseSession(storage?.getItem(SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

// In-memory copy of the stored session; the token getter reads it.
let current: Session | null | undefined;

function currentSession(): Session | null {
  if (current === undefined) current = readSession();
  return current;
}

export function writeSession(session: Session): void {
  current = session;
  try {
    safeStorage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked: the session lasts for this page only.
  }
}

export function clearSession(): void {
  current = null;
  try {
    safeStorage()?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

setTokenGetter(() => currentSession()?.token ?? null);

/** `POST /api/auth/login` without a bearer token. Throws `ApiError` or a network error. */
export function loginRequest(
  username: string,
  password: string,
  fetchImpl?: typeof fetch,
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    token: null,
    fetchImpl,
  });
}

/**
 * What `/login` does with the cached session (Req 37.5):
 * - `'redirect'`: a usable session with a working token goes straight to its area;
 * - `'reauth'`: an ASHA whose token expired (or got a 401) sees the form to sign in
 *   again, and can go back to local work; the session stays until a new login
 *   replaces it;
 * - `'form'`: no usable session, show the plain form.
 */
export type LoginMode = 'redirect' | 'reauth' | 'form';

export function loginMode(session: Session | null, usable: boolean, tokenExpired: boolean): LoginMode {
  if (!session || !usable) return 'form';
  return tokenExpired ? 'reauth' : 'redirect';
}

// ------------------------------------------------------------------ React context

export interface AuthContextValue {
  session: Session | null;
  user: UserOut | null;
  token: string | null;
  /** The cached token is past its expiry, or the server rejected it with 401. */
  tokenExpired: boolean;
  /**
   * A session that may enter its area: any ASHA session (offline work with an
   * expired token, Req 37.5), or a staff session whose token is still valid.
   */
  usable: boolean;
  login: (username: string, password: string) => Promise<UserOut>;
  logout: () => void;
  /** Record a 401 from the server for the current token (sync engine, live client). */
  markUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// setTimeout's maximum delay (~24.8 days).
const MAX_TIMEOUT_MS = 2_147_483_647;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => currentSession());
  const [unauthorizedToken, setUnauthorizedToken] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Re-render when the token expires so `tokenExpired` flips without a reload.
  useEffect(() => {
    if (!session) return;
    const exp = Date.parse(session.expiresAt);
    if (Number.isNaN(exp)) return;
    const delay = exp - Date.now();
    if (delay <= 0) return;
    const id = setTimeout(() => setNowMs(Date.now()), Math.min(delay + 50, MAX_TIMEOUT_MS));
    return () => clearTimeout(id);
  }, [session]);

  // Keep tabs in step: a login or logout in another tab updates this one.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== SESSION_STORAGE_KEY) return;
      current = undefined;
      setSession(currentSession());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await loginRequest(username, password);
    const next = sessionFromLogin(res);
    writeSession(next);
    setUnauthorizedToken(null);
    setNowMs(Date.now());
    setSession(next);
    return next.user;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUnauthorizedToken(null);
    setSession(null);
  }, []);

  const markUnauthorized = useCallback(() => {
    const token = currentSession()?.token ?? null;
    if (token) setUnauthorizedToken(token);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const tokenExpired =
      session !== null && (unauthorizedToken === session.token || isSessionExpired(session, nowMs));
    const usable = session !== null && (session.user.role === 'asha' || !tokenExpired);
    return {
      session,
      user: session?.user ?? null,
      token: session?.token ?? null,
      tokenExpired,
      usable,
      login,
      logout,
      markUnauthorized,
    };
  }, [session, unauthorizedToken, nowMs, login, logout, markUnauthorized]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
