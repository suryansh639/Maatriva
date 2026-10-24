/**
 * Live-client reconnect schedule (Req 19.4; design §15 "live/backoff.ts").
 *
 * Delays of 1, 2, 5 and 10 seconds, staying at 10 seconds after that. The
 * caller resets its attempt counter to 0 when a `hello` event arrives. The
 * server's `retry: 3000` is parsed but intentionally not used (design
 * deviation #2). No jitter. Pure: no DOM, no timers.
 */

export const BACKOFF_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10000];

/** Delay in ms before reconnect attempt `attempt` (0-based). */
export function backoffDelay(attempt: number): number {
  const i = Number.isFinite(attempt) && attempt > 0 ? Math.min(Math.floor(attempt), 3) : 0;
  return BACKOFF_DELAYS_MS[i];
}
