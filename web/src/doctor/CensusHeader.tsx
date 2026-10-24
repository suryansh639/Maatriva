/**
 * Census KPI cards (Req 20.2): the 7 cards with their exact labels. Risk cards use
 * the shared risk palette with an icon and a word, never color alone (Req 38.2).
 * No focusable elements, so it adds nothing to the tab order (Req 38.4).
 */
import { RISK_PALETTE } from '../shared/RiskChip';
import type { CensusOut } from '../shared/types';
import { kpiCards } from './census';

export interface CensusHeaderProps {
  census: CensusOut;
}

export function CensusHeader({ census }: CensusHeaderProps) {
  const cards = kpiCards(census);
  return (
    <section className="census-header" aria-labelledby="census-heading">
      <h2 id="census-heading" className="census-header__title">
        Census <span className="census-header__asof">as of {census.as_of} (IST)</span>
      </h2>
      <ul className="kpi-grid">
        {cards.map((card) => {
          const palette = card.risk ? RISK_PALETTE[card.risk] : null;
          return (
            <li
              key={card.key}
              className={`kpi-card kpi-card--${card.key}`}
              data-risk={card.risk}
              style={palette ? { background: palette.background, color: palette.color } : undefined}
            >
              <span className="kpi-card__label">
                {palette ? (
                  <span className="kpi-card__icon" aria-hidden="true">
                    {palette.icon}{' '}
                  </span>
                ) : null}
                {card.label}
              </span>
              <span className="kpi-card__value">{card.value}</span>
              {card.detail ? <span className="kpi-card__detail">{card.detail}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default CensusHeader;
