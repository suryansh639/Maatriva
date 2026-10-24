/**
 * Logout guard for the field area (Req 37.7).
 *
 * With queued outbox entries the ASHA is asked to confirm first. Logging out never
 * deletes the per-user Dexie database, so the queued changes sync after the same
 * user signs in again.
 */
import type { InterpolationVars, MessageKey } from '../shared/i18n';

export type Translate = (key: MessageKey, vars?: InterpolationVars) => string;
export type ConfirmFn = (message: string) => boolean;

function defaultConfirm(message: string): boolean {
  return typeof window === 'undefined' || typeof window.confirm !== 'function' ? true : window.confirm(message);
}

/**
 * True when logout may proceed: always with an empty outbox, otherwise only when
 * the user confirms the translated "{n} changes are not synced yet" warning.
 */
export function confirmLogout(pendingCount: number, t: Translate, confirmFn: ConfirmFn = defaultConfirm): boolean {
  const n = Number.isFinite(pendingCount) && pendingCount > 0 ? Math.floor(pendingCount) : 0;
  if (n === 0) return true;
  return confirmFn(t('field.common.logoutPending', { n }));
}
