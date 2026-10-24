/**
 * Web Bluetooth scale UI (Req 35.1–35.8, 33.11).
 *
 * - Unsupported browser / insecure context → the Chrome/HTTPS message.
 * - "Connect scale" runs the 0x181D / 0x2A9D flow; each measurement is listed
 *   with its raw hex and kilograms.
 * - "Use this reading" takes the latest successful measurement, and is disabled
 *   when that measurement is outside 25–150 kg.
 * - A cancelled device chooser returns to the visit (`onCancel`) with no message.
 * - Finishing ("Use this reading", "Stop") or unmounting stops notifications
 *   and disconnects GATT.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageKey } from '../../shared/i18n';
import { useI18n } from '../../shared/I18nProvider';
import ReadingView from './ReadingView';
import { isUsableReading, latestSuccessful } from './scale';
import type { ScaleReader, ScaleReading, ScaleStatus } from './scale';
import { WebBluetoothScaleReader, isWebBluetoothAvailable } from './webBluetooth';
import './scale.css';

export interface BleScaleReaderProps {
  /** Called with the latest successful, plausible reading. */
  onUse: (reading: ScaleReading) => void;
  /** Return to the visit: chooser cancelled, or "Stop" without a reading. */
  onCancel: () => void;
  /** Injectable for tests or previews. */
  createReader?: () => ScaleReader;
  /** Overrides the feature check (tests, previews). */
  supported?: boolean;
}

export default function BleScaleReader({
  onUse,
  onCancel,
  createReader,
  supported,
}: BleScaleReaderProps) {
  const { t } = useI18n();
  const id = useId();
  const readerRef = useRef<ScaleReader | null>(null);
  const [status, setStatus] = useState<ScaleStatus>('idle');
  const [readings, setReadings] = useState<ScaleReading[]>([]);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const available = supported ?? isWebBluetoothAvailable();

  const getReader = (): ScaleReader => {
    if (!readerRef.current) {
      readerRef.current = createReader ? createReader() : new WebBluetoothScaleReader();
    }
    return readerRef.current;
  };

  useEffect(() => {
    return () => {
      void readerRef.current?.stop();
    };
  }, []);

  const connect = () => {
    setMessage(null);
    void getReader().start({
      onStatus: setStatus,
      onReading: (r) => {
        setMessage(null);
        setReadings((prev) => [...prev, r]);
      },
      onError: setMessage,
      onCancel,
    });
  };

  const stop = () => {
    void readerRef.current?.stop();
    setStatus('idle');
    if (readings.length === 0) onCancel();
  };

  if (!available) {
    return (
      <section className="scale-panel" aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>{t('field.ble.title')}</h3>
        <p role="alert">{t('field.ble.unsupported')}</p>
      </section>
    );
  }

  const latest = latestSuccessful(readings);
  const usable = isUsableReading(latest);
  const busy = status === 'connecting';
  const listening = status === 'waiting';

  return (
    <section className="scale-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('field.ble.title')}</h3>

      <div role="status" aria-live="polite">
        {busy ? <p>{t('field.ble.connecting')}</p> : null}
        {listening ? <p>{t('field.ble.waiting')}</p> : null}
        {message ? <p className="form-error">{t(message)}</p> : null}
      </div>

      <div className="scale-panel__row">
        {!busy && !listening ? (
          <button type="button" className="btn btn--primary" onClick={connect}>
            {t('field.ble.connect')}
          </button>
        ) : null}
        {busy || listening ? (
          <button type="button" className="btn" onClick={stop}>
            {t('field.ble.stop')}
          </button>
        ) : null}
      </div>

      {readings.length > 0 ? (
        <>
          <h4 id={`${id}-readings`}>{t('field.ble.readings')}</h4>
          <ol className="scale-readings" aria-labelledby={`${id}-readings`} reversed>
            {readings
              .map((r, i) => ({ r, i }))
              .reverse()
              .map(({ r, i }) => (
                <li key={i}>
                  <ReadingView reading={r} />
                </li>
              ))}
          </ol>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!usable}
            onClick={() => {
              if (!isUsableReading(latest)) return;
              void readerRef.current?.stop();
              setStatus('stopped');
              onUse(latest);
            }}
          >
            {t('field.scale.useReading')}
          </button>
        </>
      ) : null}
    </section>
  );
}
