/**
 * Sync badge in the field header (Req 28.1–28.3, 37.5).
 *
 * - Shows the `deriveBadge` state from `SyncProvider` with an icon, text and a
 *   tone color (never color alone), e.g. "Offline (simulated) · 1 pending".
 * - The text sits in an `aria-live="polite"` region, so state changes are announced.
 * - It is a button: activating it calls `onActivate` with the current state. The
 *   layout opens the sync-errors screen, or the sign-in flow for "Sign in to sync".
 * - Stable hooks for the E2E script: `data-testid="sync-badge"` and `data-kind`.
 */
import { useI18n } from '../../shared/I18nProvider';
import { BADGE_TONE_COLORS, badgeText, type BadgeState } from './badge';
import { useSync } from './SyncProvider';

export interface SyncBadgeProps {
  onActivate?: (badge: BadgeState) => void;
}

export function SyncBadge({ onActivate }: SyncBadgeProps) {
  const { badge } = useSync();
  const { t } = useI18n();
  const colors = BADGE_TONE_COLORS[badge.tone];
  const text = badgeText(badge, t);

  return (
    <div className="sync-badge-region" aria-live="polite" aria-atomic="true">
      <button
        type="button"
        className="sync-badge"
        data-testid="sync-badge"
        data-kind={badge.kind}
        data-tone={badge.tone}
        style={{ background: colors.bg, color: colors.fg, borderColor: colors.fg }}
        onClick={() => onActivate?.(badge)}
      >
        <span className="sync-badge__icon" aria-hidden="true">
          {badge.icon}
        </span>
        <span className="sync-badge__text">{text}</span>
      </button>
    </div>
  );
}

export default SyncBadge;
