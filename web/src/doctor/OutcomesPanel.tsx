/**
 * Outcome counts panel for the dashboard panels slot (Req 24.6–24.8). English only.
 *
 * Loads `GET /api/outcomes` on mount and whenever `refetchTick` changes (the
 * dashboard passes its live / interval tick). The last good counts stay visible
 * while refetching or after an error. Explanatory text gives the 0.5 g/dL rule.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../shared/api';
import type { OutcomesOut } from '../shared/types';
import { getOutcomes } from './doctorApi';
import { HB_IMPROVED_MIN_DELTA, LBW_THRESHOLD_KG } from './doctorForms';
import './outcomes.css';

export interface OutcomesPanelProps {
  /** Any change refetches the counts. */
  refetchTick?: number;
}

export const HB_IMPROVED_EXPLANATION =
  `"Hb improved after action" counts mothers with at least one doctor action whose latest Hb after ` +
  `the first action is at least ${HB_IMPROVED_MIN_DELTA} g/dL above their latest Hb on or before that day. ` +
  `Only mothers with an Hb reading both before and after the first action are counted.`;

export function OutcomesView({ outcomes }: { outcomes: OutcomesOut }) {
  return (
    <>
      <dl className="outcomes__list">
        <div>
          <dt>Hb improved after action</dt>
          <dd data-testid="outcome-hb-improved">
            {`${outcomes.hb_improved_after_action} of ${outcomes.mothers_with_action_and_followup_hb}`}
            <span className="outcomes__unit"> mothers with an action and a follow-up Hb</span>
          </dd>
        </div>
        <div>
          <dt>Births recorded</dt>
          <dd data-testid="outcome-births">{outcomes.births_recorded}</dd>
        </div>
        <div>
          <dt>Live births</dt>
          <dd data-testid="outcome-live-births">{outcomes.live_births}</dd>
        </div>
        <div>
          <dt>Low birth weight (below {LBW_THRESHOLD_KG} kg)</dt>
          <dd data-testid="outcome-lbw">{outcomes.lbw_count}</dd>
        </div>
      </dl>
      <p className="outcomes__note">{HB_IMPROVED_EXPLANATION}</p>
      <p className="outcomes__note">Counts are derived from this PHC's own synthetic records.</p>
    </>
  );
}

export function OutcomesPanel({ refetchTick = 0 }: OutcomesPanelProps) {
  const [outcomes, setOutcomes] = useState<OutcomesOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  const retry = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    getOutcomes(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setOutcomes(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(isApiError(err) ? err.message : 'Check the connection.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [refetchTick, version]);

  return (
    <section className="panel outcomes" aria-labelledby="outcomes-heading" aria-busy={loading}>
      <h2 id="outcomes-heading">Outcomes</h2>
      {outcomes ? <OutcomesView outcomes={outcomes} /> : loading ? <p role="status">Loading outcomes…</p> : null}
      {error ? (
        <div role="alert">
          <p className="form-error">Could not load outcomes: {error}</p>
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default OutcomesPanel;
