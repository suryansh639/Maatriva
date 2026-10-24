/**
 * Sync badge state (Req 28.1; design §16 "deriveBadge").
 *
 * `deriveBadge` is pure. It picks exactly one state, in this priority order:
 *   1. simulated offline  → "Offline (simulated)"
 *   2. offline            → "Offline"
 *   3. auth needed        → "Sign in to sync"
 *   4. forbidden          → "Not allowed"
 *   5. syncing            → "Syncing…"
 *   6. last cycle failed  → "Sync error – will retry"
 *   7. sync errors > 0    → "{N} sync errors"
 *   8. pending > 0        → "{N} pending"
 *   9. otherwise          → "Synced {hh:mm}" ("Not synced yet" before the first sync)
 *
 * While offline (1 or 2) and the outbox is not empty, the pending count is added as a
 * suffix, so the text reads e.g. "Offline (simulated) · 1 pending" (E2E step 6).
 * Every state carries an icon, a message key and a tone (mapped to a color).
 */

import type { InterpolationVars, MessageKey } from '../../shared/i18n';

export type BadgeKind =
  | 'offlineSimulated'
  | 'offline'
  | 'signIn'
  | 'forbidden'
  | 'syncing'
  | 'error'
  | 'syncErrors'
  | 'pending'
  | 'synced';

export type AuthState = 'ok' | 'needed' | 'forbidden';

export type BadgeTone = 'offline' | 'busy' | 'pending' | 'ok' | 'warning' | 'error';

/** Inputs of the badge. */
export interface SyncStatus {
  online: boolean;
  simulatedOffline: boolean;
  syncing: boolean;
  pendingCount: number;
  syncErrorCount: number;
  /** ISO-8601 instant of the last successful cycle, or null before the first one. */
  lastSyncAt: string | null;
  /** `needed` after a 401 or with an expired token (Req 37.5); `forbidden` after a 403. */
  auth: AuthState;
  /** The last cycle stopped on a network error, a timeout or a 5xx (Req 27.10). */
  lastCycleFailed: boolean;
}

export interface BadgeMessage {
  key: MessageKey;
  vars?: InterpolationVars;
}

export interface BadgeState {
  kind: BadgeKind;
  icon: string;
  tone: BadgeTone;
  message: BadgeMessage;
  /** Extra message joined with " · " (the pending count while offline). */
  suffix: BadgeMessage | null;
  /** True when activating the badge should list the rejected changes (Req 28.3). */
  showsErrors: boolean;
}

/** Text and background colors per tone; every pair has a contrast ratio ≥ 4.5:1. */
export const BADGE_TONE_COLORS: Readonly<Record<BadgeTone, { fg: string; bg: string }>> = {
  offline: { fg: '#ffffff', bg: '#4a4a4a' },
  busy: { fg: '#ffffff', bg: '#1a4fd6' },
  pending: { fg: '#3b2a00', bg: '#ffd166' },
  ok: { fg: '#ffffff', bg: '#1b6e3a' },
  warning: { fg: '#3b2a00', bg: '#ffd166' },
  error: { fg: '#ffffff', bg: '#a50e0e' },
};

export const BADGE_SEPARATOR = ' · ';

/** Local "hh:mm" (24-hour) of an ISO instant. */
export function formatHhMm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function state(
  kind: BadgeKind,
  icon: string,
  tone: BadgeTone,
  message: BadgeMessage,
  suffix: BadgeMessage | null = null,
  showsErrors = false,
): BadgeState {
  return { kind, icon, tone, message, suffix, showsErrors };
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Pick the badge state for `s` (priority order in the module docstring). */
export function deriveBadge(s: SyncStatus, formatTime: (iso: string) => string = formatHhMm): BadgeState {
  const pending = count(s.pendingCount);
  const errors = count(s.syncErrorCount);
  const pendingSuffix: BadgeMessage | null = pending > 0 ? { key: 'sync.badge.pending', vars: { n: pending } } : null;

  if (s.simulatedOffline) {
    return state('offlineSimulated', '⊘', 'offline', { key: 'sync.badge.offlineSimulated' }, pendingSuffix);
  }
  if (!s.online) {
    return state('offline', '⊘', 'offline', { key: 'sync.badge.offline' }, pendingSuffix);
  }
  if (s.auth === 'needed') {
    return state('signIn', '🔒', 'warning', { key: 'sync.badge.signIn' });
  }
  if (s.auth === 'forbidden') {
    return state('forbidden', '⛔', 'error', { key: 'sync.badge.forbidden' });
  }
  if (s.syncing) {
    return state('syncing', '⟳', 'busy', { key: 'sync.badge.syncing' });
  }
  if (s.lastCycleFailed) {
    return state('error', '⚠', 'warning', { key: 'sync.badge.error' });
  }
  if (errors > 0) {
    const message: BadgeMessage =
      errors === 1 ? { key: 'sync.badge.errorsOne' } : { key: 'sync.badge.errors', vars: { n: errors } };
    return state('syncErrors', '⚠', 'error', message, null, true);
  }
  if (pending > 0) {
    return state('pending', '⏳', 'pending', { key: 'sync.badge.pending', vars: { n: pending } });
  }
  if (s.lastSyncAt) {
    return state('synced', '✓', 'ok', { key: 'sync.badge.synced', vars: { time: formatTime(s.lastSyncAt) } });
  }
  return state('synced', '✓', 'ok', { key: 'sync.badge.neverSynced' });
}

/** Render a badge state's text with a translator, joining the suffix with " · ". */
export function badgeText(b: BadgeState, t: (key: MessageKey, vars?: InterpolationVars) => string): string {
  const main = t(b.message.key, b.message.vars);
  return b.suffix ? `${main}${BADGE_SEPARATOR}${t(b.suffix.key, b.suffix.vars)}` : main;
}
