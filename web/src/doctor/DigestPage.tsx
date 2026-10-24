/**
 * AMBER digest page, `/doctor/digest` (Req 25.1–25.3). Doctors and ANMs. English only.
 *
 * - Loads `GET /api/digest`: the facility's open AMBER alerts of the last 7 days,
 *   grouped by village. Each item shows the risk chip, Short_Code, mother name and
 *   flag reasons, with a link to the patient.
 * - "Send digest SMS (mock)" posts `POST /api/digest/send`, which writes one
 *   `amber_digest` mock SMS per ANM, and reports how many rows were written.
 *
 * Refetches on every `refetchTick` change and on `risk.changed` events (AMBER
 * alerts have no event of their own), debounced 300 ms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../shared/api';
import { RiskChip } from '../shared/RiskChip';
import { formatIstHHMM, istDate, parseIsoZ } from '../shared/time';
import type { DigestOut } from '../shared/types';
import { getDigest, sendDigest } from './doctorApi';
import type { LiveEventsState } from './live/useLiveEvents';
import { patientPath } from './TriageQueue';
import './panels.css';

export const DIGEST_REFETCH_DEBOUNCE_MS = 300;
export const SEND_DIGEST_LABEL = 'Send digest SMS (mock)';

/** The confirmation shown after `POST /api/digest/send`. */
export function digestSentMessage(count: number): string {
  if (count === 0) return 'No ANM in this facility, so no mock SMS was written.';
  return `Digest written as ${count} mock SMS ${count === 1 ? 'row' : 'rows'} (not sent). See the Mock SMS log on the dashboard.`;
}

function formatDateTime(iso: string): string {
  const ms = parseIsoZ(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${istDate(ms)} ${formatIstHHMM(ms)} IST`;
}

export function DigestView({ digest }: { digest: DigestOut }) {
  if (digest.villages.length === 0) {
    return <p className="panel__empty">No open AMBER alerts in the last 7 days.</p>;
  }
  return (
    <>
      <p className="digest__summary">
        {digest.total} open AMBER {digest.total === 1 ? 'alert' : 'alerts'} raised since{' '}
        {formatDateTime(digest.since)}, across {digest.villages.length}{' '}
        {digest.villages.length === 1 ? 'village' : 'villages'}.
      </p>
      {digest.villages.map((v) => (
        <section key={v.village_id} className="digest__village" aria-labelledby={`digest-v-${v.village_id}`}>
          <h2 id={`digest-v-${v.village_id}`}>
            {v.village_name} <span className="digest__count">({v.count})</span>
          </h2>
          <ul className="digest__items">
            {v.items.map((item) => (
              <li key={item.alert_id} className="digest__item">
                <div className="digest__item-head">
                  <RiskChip level={item.risk_level} />
                  <span className="digest__code">{item.short_code}</span>
                  <strong>{item.mother_name}</strong>
                  <Link to={patientPath(item.mother_id)} aria-label={`Open patient ${item.mother_name}`}>
                    Open patient
                  </Link>
                </div>
                {item.reasons.length > 0 ? (
                  <ul className="digest__reasons">
                    {item.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="digest__meta">Raised {formatDateTime(item.created_at)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export interface DigestPageProps {
  /** Shared live connection from the doctor layout. */
  live?: Pick<LiveEventsState, 'subscribe' | 'refetchTick'>;
}

export default function DigestPage({ live }: DigestPageProps) {
  const [digest, setDigest] = useState<DigestOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const refetchTick = live?.refetchTick ?? 0;
  const subscribe = live?.subscribe;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    getDigest(ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setDigest(data);
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

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!subscribe) return;
    const unsubscribe = subscribe((ev) => {
      if (ev.type !== 'risk.changed') return;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        reload();
      }, DIGEST_REFETCH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [subscribe, reload]);

  const onSend = useCallback(async () => {
    setSending(true);
    setSendMessage(null);
    try {
      const res = await sendDigest();
      setSendMessage({ tone: 'ok', text: digestSentMessage(res.count) });
    } catch (err) {
      setSendMessage({
        tone: 'error',
        text: isApiError(err) ? `Could not send the digest: ${err.message}` : 'Could not send the digest – try again.',
      });
    } finally {
      setSending(false);
    }
  }, []);

  return (
    <div className="digest" aria-busy={loading}>
      <div className="digest__head">
        <h1 className="digest__title">AMBER digest – last 7 days</h1>
        <button type="button" className="btn btn--primary" onClick={() => void onSend()} disabled={sending}>
          {sending ? 'Sending…' : SEND_DIGEST_LABEL}
        </button>
      </div>
      <p className="digest__note">
        Routine follow-up for the ANM. The digest SMS is a mock: it is only written to the SMS log, never sent.
      </p>
      <div role="status" aria-live="polite" className="digest__send-status">
        {sendMessage ? (
          <p className={sendMessage.tone === 'error' ? 'form-error' : 'digest__ok'}>{sendMessage.text}</p>
        ) : null}
      </div>

      {digest ? <DigestView digest={digest} /> : loading ? <p role="status">Loading digest…</p> : null}
      {error ? (
        <div role="alert">
          <p className="form-error">Could not load the digest: {error}</p>
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
