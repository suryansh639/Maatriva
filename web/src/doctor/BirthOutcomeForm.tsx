/**
 * Birth outcome form on the patient page (Req 24.1–24.5, 37.8). English only.
 *
 * Rendered for doctors only, for active mothers with GA of at least 20 weeks and
 * no recorded outcome. Fields: delivery date (LMP + 140 days..today), outcome
 * (live birth / stillbirth) and birth weight (0.3–6.0 kg, required for a live
 * birth; "Low birth weight" is shown below 2.5 kg). Submit →
 * `POST /api/mothers/{id}/birth-outcome`; 409 ALREADY_RECORDED / MOTHER_INACTIVE
 * refresh the detail. Recording marks the mother delivered, closes her alerts
 * and cancels her open tasks (Req 16.10), so the form says so up front.
 */
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { BirthOutcomeKind, BirthOutcomeOut, MotherDetailOut } from '../shared/types';
import { recordBirthOutcome } from './doctorApi';
import {
  BIRTH_WEIGHT_MAX,
  BIRTH_WEIGHT_MIN,
  LBW_THRESHOLD_KG,
  buildBirthOutcome,
  canRecordOutcome,
  initialOutcomeForm,
  isLowBirthWeight,
  minDeliveryDate,
  outcomeErrorMessage,
  parseWeight,
  validateOutcomeForm,
} from './doctorForms';
import type { OutcomeFormErrors, OutcomeFormValues } from './doctorForms';

export interface BirthOutcomeFormProps {
  detail: MotherDetailOut;
  /** IST date today ("YYYY-MM-DD"). */
  today: string;
  isDoctor: boolean;
  reload: () => void;
  onRecorded?: (outcome: BirthOutcomeOut) => void;
}

const OUTCOME_OPTIONS: ReadonlyArray<{ value: BirthOutcomeKind; label: string }> = [
  { value: 'live_birth', label: 'Live birth' },
  { value: 'stillbirth', label: 'Stillbirth' },
];

export function BirthOutcomeForm({ detail, today, isDoctor, reload, onRecorded }: BirthOutcomeFormProps) {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    date: `${uid}-date`,
    dateError: `${uid}-date-error`,
    weight: `${uid}-weight`,
    weightHint: `${uid}-weight-hint`,
    weightError: `${uid}-weight-error`,
  };
  const motherId = detail.mother.id;
  const lmp = detail.mother.lmp_date;

  const [values, setValues] = useState<OutcomeFormValues>(() => initialOutcomeForm(today));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setValues(initialOutcomeForm(today));
    setTouched(false);
    setMessage(null);
    // Only a new mother resets the form.
  }, [motherId]);

  if (!isDoctor) return null;
  if (!canRecordOutcome(detail, isDoctor)) {
    // After a successful save the detail shows the outcome; keep the announcement visible.
    return message?.tone === 'ok' ? (
      <div role="status" aria-live="polite" className="pd-form__status">
        <p className="pd-ok">{message.text}</p>
      </div>
    ) : null;
  }

  const errors: OutcomeFormErrors = validateOutcomeForm(values, lmp, today);
  const hasErrors = Object.keys(errors).length > 0;
  const shown: OutcomeFormErrors = touched ? errors : {};
  const kg = parseWeight(values.birth_weight_kg);
  const lbw = !errors.birth_weight_kg && isLowBirthWeight(kg);
  const weightRequired = values.outcome === 'live_birth';

  const set = <K extends keyof OutcomeFormValues>(key: K, value: OutcomeFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setMessage(null);
  };

  const onSubmit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setTouched(true);
    if (hasErrors || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const out = await recordBirthOutcome(motherId, buildBirthOutcome(values));
      const kind = out.outcome === 'live_birth' ? 'Live birth' : 'Stillbirth';
      const weight = out.birth_weight_kg != null ? `, ${out.birth_weight_kg.toFixed(2)} kg` : '';
      setMessage({
        tone: 'ok',
        text: `Birth outcome recorded: ${kind} on ${out.delivery_date}${weight}${out.is_lbw ? ' (low birth weight)' : ''}.`,
      });
      reload();
      onRecorded?.(out);
    } catch (err) {
      const m = outcomeErrorMessage(err);
      setMessage({ tone: 'error', text: m.text });
      if (m.reload) reload();
    } finally {
      setBusy(false);
    }
  };

  const weightDescribedBy = [ids.weightHint, shown.birth_weight_kg ? ids.weightError : null].filter(Boolean).join(' ');

  return (
    <section className="pd-form" aria-labelledby={ids.heading} data-testid="birth-outcome-form">
      <h2 id={ids.heading}>Record birth outcome</h2>
      <p className="pd-form__intro">
        Recording the outcome marks the mother delivered, closes her alerts and cancels her open tasks.
      </p>
      <form onSubmit={(ev) => void onSubmit(ev)} noValidate>
        <div className="pd-field">
          <label htmlFor={ids.date}>Delivery date</label>
          <input
            id={ids.date}
            name="delivery_date"
            type="date"
            min={minDeliveryDate(lmp)}
            max={today}
            required
            value={values.delivery_date}
            aria-invalid={shown.delivery_date ? true : undefined}
            aria-describedby={shown.delivery_date ? ids.dateError : undefined}
            onChange={(e) => set('delivery_date', e.target.value)}
          />
          {shown.delivery_date ? (
            <p id={ids.dateError} className="form-error">
              {shown.delivery_date}
            </p>
          ) : null}
        </div>

        <fieldset className="pd-field pd-radios">
          <legend>Outcome</legend>
          {OUTCOME_OPTIONS.map((o) => (
            <label key={o.value} className="pd-radio">
              <input
                type="radio"
                name={`${uid}-outcome`}
                value={o.value}
                checked={values.outcome === o.value}
                onChange={() => set('outcome', o.value)}
              />
              {o.label}
            </label>
          ))}
        </fieldset>

        <div className="pd-field">
          <label htmlFor={ids.weight}>Birth weight (kg){weightRequired ? '' : ' (optional)'}</label>
          <input
            id={ids.weight}
            name="birth_weight_kg"
            type="number"
            inputMode="decimal"
            step="0.01"
            min={BIRTH_WEIGHT_MIN}
            max={BIRTH_WEIGHT_MAX}
            required={weightRequired}
            value={values.birth_weight_kg}
            aria-invalid={shown.birth_weight_kg ? true : undefined}
            aria-describedby={weightDescribedBy}
            onChange={(e) => set('birth_weight_kg', e.target.value)}
          />
          <p id={ids.weightHint} className="pd-field__hint">
            {BIRTH_WEIGHT_MIN}–{BIRTH_WEIGHT_MAX.toFixed(1)} kg. Below {LBW_THRESHOLD_KG} kg is low birth weight.
          </p>
          {lbw ? (
            <p className="pd-tag pd-tag--overdue" data-testid="lbw-note">
              Low birth weight (below {LBW_THRESHOLD_KG} kg)
            </p>
          ) : null}
          {shown.birth_weight_kg ? (
            <p id={ids.weightError} className="form-error">
              {shown.birth_weight_kg}
            </p>
          ) : null}
        </div>

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Recording…' : 'Record birth outcome'}
        </button>
        <div role="status" aria-live="polite" className="pd-form__status">
          {message ? <p className={message.tone === 'error' ? 'form-error' : 'pd-ok'}>{message.text}</p> : null}
        </div>
      </form>
    </section>
  );
}

export default BirthOutcomeForm;
