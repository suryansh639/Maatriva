/**
 * Risk chip (Req 38.2, 38.3): every risk level is shown with an icon, a word and a
 * color, so it never relies on color alone. The palette is exported for the
 * contrast test (task 15.4).
 *
 * Labels come from `useI18n().riskLabel`, which is English outside the field
 * area's I18nProvider (the doctor area is English only, Req 32.6).
 */
import { useI18n } from './I18nProvider';
import type { RiskLevel } from './types';

export interface ChipColors {
  background: string;
  color: string;
  /** Decorative glyph; hidden from assistive technologies (the word carries the meaning). */
  icon: string;
}

export const RISK_PALETTE: Readonly<Record<RiskLevel, ChipColors>> = {
  RED: { background: '#a50e0e', color: '#ffffff', icon: '▲' },
  AMBER: { background: '#ffd166', color: '#3b2a00', icon: '◆' },
  GREEN: { background: '#1b6e3a', color: '#ffffff', icon: '●' },
};

/** Chip for a local mother whose risk the server has not computed yet (Req 26.4). */
export const PENDING_CHIP: Readonly<ChipColors> = {
  background: '#e8e8e8',
  color: '#2b2b2b',
  icon: '…',
};

export interface RiskChipProps {
  /** Null shows "Risk: pending sync". */
  level: RiskLevel | null;
  /** Overrides the translated label. */
  label?: string;
  className?: string;
}

export function RiskChip({ level, label, className }: RiskChipProps) {
  const { riskLabel, t } = useI18n();
  const colors = level ? RISK_PALETTE[level] : PENDING_CHIP;
  const text = label ?? (level ? riskLabel(level) : t('risk.pending'));
  return (
    <span
      className={className ? `risk-chip ${className}` : 'risk-chip'}
      data-risk={level ?? 'PENDING'}
      style={{ background: colors.background, color: colors.color }}
    >
      <span className="risk-chip__icon" aria-hidden="true">
        {colors.icon}
      </span>
      <span>{text}</span>
    </span>
  );
}
