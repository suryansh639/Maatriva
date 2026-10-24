/**
 * API client (Req 37.9).
 *
 * Backend error bodies come in two shapes:
 * - domain errors: `{"detail": {"code": "...", "message": "..."}}`
 * - FastAPI validation errors: `{"detail": [{"loc": [...], "msg": "...", ...}]}` (422)
 *
 * `toApiError` (pure) normalizes both, and anything else, into one `ApiError`
 * with a status, a non-empty code and a non-empty message.
 *
 * Network failures and aborts are NOT converted: `apiFetch` rethrows the original
 * `TypeError` / `DOMException`, so callers such as the sync engine can tell a
 * network error or timeout from an HTTP error.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function genericMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request';
    case 401:
      return 'Not authenticated';
    case 403:
      return 'Not allowed';
    case 404:
      return 'Not found';
    case 409:
      return 'Conflict';
    case 422:
      return 'Invalid data';
    default:
      return status >= 500 ? `Server error (HTTP ${status})` : `Request failed (HTTP ${status})`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `"<loc>: <msg>"` of one FastAPI validation item, or null when it has no message. */
function validationItemMessage(item: unknown): string | null {
  if (!isRecord(item) || !nonEmptyString(item.msg)) return null;
  const loc = Array.isArray(item.loc)
    ? item.loc.filter((p) => typeof p === 'string' || typeof p === 'number').join('.')
    : '';
  return loc ? `${loc}: ${item.msg}` : item.msg;
}

/**
 * Normalize an HTTP error response. `body` is the parsed JSON body when the
 * response was JSON, the raw text otherwise, or undefined/null when empty.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const detail = isRecord(body) ? body.detail : undefined;

  if (isRecord(detail) && nonEmptyString(detail.code) && nonEmptyString(detail.message)) {
    return new ApiError(status, detail.code, detail.message);
  }

  if (Array.isArray(detail)) {
    const message =
      detail.map(validationItemMessage).find((m): m is string => m !== null) ?? genericMessage(422);
    return new ApiError(status, 'VALIDATION_ERROR', message);
  }

  return new ApiError(status, `HTTP_${status}`, genericMessage(status));
}

// ------------------------------------------------------------------ fetch wrapper

export type TokenGetter = () => string | null;

let tokenGetter: TokenGetter = () => null;

/** Registered by the session provider so `apiFetch` sends the current bearer token. */
export function setTokenGetter(getter: TokenGetter): void {
  tokenGetter = getter;
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialized as the request body. */
  body?: unknown;
  /** Query parameters; null/undefined values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Bearer token; defaults to the registered token getter. `null` sends none. */
  token?: string | null;
  signal?: AbortSignal;
  /** Injectable fetch (tests, sync engine). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/** Request headers with `Authorization: Bearer <token>` when a token is given. */
export function authHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildUrl(path: string, query: ApiFetchOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Call a backend endpoint (path like `/api/me`) and return its parsed JSON.
 * Throws `ApiError` for any non-2xx response (also when a 2xx body is not JSON).
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = options.body === undefined ? 'GET' : 'POST', body, query, signal } = options;
  const token = options.token === undefined ? tokenGetter() : options.token;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(token),
    ...options.headers,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const parsed = await readBody(res);
  if (!res.ok) throw toApiError(res.status, parsed);
  if (res.status === 204 || parsed === null) return undefined as T;
  if (typeof parsed === 'string') {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'Unexpected non-JSON response');
  }
  return parsed as T;
}
