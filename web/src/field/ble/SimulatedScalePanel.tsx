/**
 * Simulated scale UI (Req 34.6, 34.7, 33.11).
 *
 * Target weight (default: the mother's last weight, or 55.0 kg), optional
 * ±0.2 kg jitter (off by default), "Demo preset (56.6 kg)" and "Step on scale".
 * After 1 s of "Stabilizing…" it shows the real 0x2A9D bytes in monospace and
 * the kilograms parsed from them. Readings outside 25–150 kg cannot be used.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../shared/I18nProvider';
import ReadingView from './ReadingView';
import { round2 } from './round';
import { isUsableReading } from './scale';
import type { ScaleReading, ScaleStatus } from './scale';
import { DEMO_PRESET_KG, SimulatedScaleReader, defaultTargetKg } from './simulatedScale';
import './scale.css';

export interface SimulatedScaleProps {
  /** The mother's last recorded weight, used as the default target. */
  lastWeightKg?: number | null;
  /** Called with a parsed, plausible reading when "Use this reading" is pressed. */
  onUse: (reading: ScaleReading) => void;
  /** Injectable for tests or previews. */
  createReader?: () => SimulatedScaleReader;
}

/** 58 → "58.0", 56.6 → "56.6", 56.25 → "56.25". */
function formatTarget(kg: number): string {
  return round2(kg).toFixed(2).replace(/(\.\d)0$/, '$1');
}

/** Parse the typed target; accepts "," as the decimal mark. */
function parseTarget(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n > 0 ? n : null;
}

export default function SimulatedScale({ lastWeightKg, onUse, createReader }: SimulatedScaleProps) {
  const { t } = useI18n();
  const id = useId();
  const readerRef = useRef<SimulatedScaleReader | null>(null);
  const [target, setTarget] = useState(() => formatTarget(defaultTargetKg(lastWeightKg)));
  const [jitter, setJitter] = useState(false);
  const [status, setStatus] = useState<ScaleStatus>('idle');
  const [reading, setReading] = useState<ScaleReading | null>(null);

  const getReader = (): SimulatedScaleReader => {
    if (!readerRef.current) {
      readerRef.current = createReader ? createReader() : new SimulatedScaleReader();
    }
    return readerRef.current;
  };

  useEffect(() => {
    const reader = getReader();
    void reader.start({ onStatus: setStatus, onReading: setReading });
    return () => {
      void reader.stop();
    };
    // The reader instance lives for the component's lifetime.
  }, []);

  const targetKg = parseTarget(target);
  const stabilizing = status === 'stabilizing';
  const usable = isUsableReading(reading);
  const errorId = `${id}-target-error`;

  const step = () => {
    if (targetKg === null) return;
    setReading(null);
    void getReader().step(targetKg, { jitter });
  };

  return (
    <section className="scale-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('field.scale.simTitle')}</h3>

      <div className="form-field">
        <label htmlFor={`${id}-target`}>{t('field.scale.targetWeight')}</label>
        <input
          id={`${id}-target`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-invalid={targetKg === null}
          aria-describedby={targetKg === null ? errorId : undefined}
          disabled={stabilizing}
        />
        {targetKg === null ? (
          <p id={errorId} className="form-error">
            {t('validation.number')}
          </p>
        ) : null}
      </div>

      <label className="scale-panel__check" htmlFor={`${id}-jitter`}>
        <input
          id={`${id}-jitter`}
          type="checkbox"
          checked={jitter}
          onChange={(e) => setJitter(e.target.checked)}
          disabled={stabilizing}
        />
        {t('field.scale.jitter')}
      </label>

      <div className="scale-panel__row">
        <button
          type="button"
          className="btn"
          disabled={stabilizing}
          onClick={() => {
            setTarget(formatTarget(DEMO_PRESET_KG));
            setJitter(false);
          }}
        >
          {t('field.scale.demoPreset')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={stabilizing || targetKg === null}
          onClick={step}
        >
          {t('field.scale.stepOn')}
        </button>
      </div>

      <div role="status" aria-live="polite">
        {stabilizing ? <p>{t('field.scale.stabilizing')}</p> : null}
        {!stabilizing && reading ? <ReadingView reading={reading} /> : null}
      </div>

      {reading && !stabilizing ? (
        <button
          type="button"
          className="btn btn--primary"
          disabled={!usable}
          onClick={() => {
            if (isUsableReading(reading)) onUse(reading);
          }}
        >
          {t('field.scale.useReading')}
        </button>
      ) : null}
    </section>
  );
}
