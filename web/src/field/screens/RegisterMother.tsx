/**
 * Register a mother (Req 29.6, 29.7, 26.2–26.4).
 *
 * Fields: name, age, husband/guardian name, village (local villages table), optional
 * phone, LMP (max today, IST) with a live GA/EDD preview, BPL, height and the first
 * weight, typed manually or captured from the simulated / Bluetooth scale.
 *
 * Every change is checked with `validateMotherDraft` (the client mirror of the
 * Requirement 11 server rules). A field's error is shown inline, linked through
 * `aria-describedby`, once the field has been touched; Save stays disabled while
 * anything is invalid. Save writes the row and its outbox entry in one transaction
 * (`saveMother`), then opens the new mother's detail screen, where the risk shows
 * "Risk: pending sync" until the first pull.
 */
import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { eddNaegele, gaDays, gaLabel } from '../../shared/gestation';
import type { MessageKey } from '../../shared/i18n';
import { useI18n } from '../../shared/I18nProvider';
import { todayIST } from '../../shared/time';
import type { VillageOut } from '../../shared/types';
import BleScaleReader from '../ble/BleScaleReader';
import type { ScaleReading } from '../ble/scale';
// The UI file is `SimulatedScalePanel.tsx`: `SimulatedScale.tsx` collided with
// `simulatedScale.ts` on case-insensitive file systems (Windows).
import SimulatedScale from '../ble/SimulatedScalePanel';
import { saveMother } from '../outbox';
import { motherPath } from '../paths';
import { useSync } from '../sync/SyncProvider';
import {
  isStrictIsoDate,
  parseIntegerInput,
  parseNumberInput,
  validateMotherDraft,
  type FieldErrors,
  type MotherField,
} from '../validation';
import './mothers.css';

type FormField =
  | 'full_name'
  | 'age'
  | 'guardian_name'
  | 'village_id'
  | 'phone'
  | 'lmp_date'
  | 'height_cm'
  | 'first_weight_kg';

type WeightMode = 'manual' | 'simulated' | 'ble';

const EMPTY_VILLAGES: VillageOut[] = [];

interface FormState {
  full_name: string;
  age: string;
  guardian_name: string;
  village_id: string;
  phone: string;
  lmp_date: string;
  is_bpl: boolean;
  height_cm: string;
  weight: string;
}

const INITIAL: FormState = {
  full_name: '',
  age: '',
  guardian_name: '',
  village_id: '',
  phone: '',
  lmp_date: '',
  is_bpl: false,
  height_cm: '',
  weight: '',
};

export function RegisterMother() {
  const { t } = useI18n();
  const { db } = useSync();
  const navigate = useNavigate();
  const uid = useId();

  const villages = useLiveQuery(
    async () => (await db.villages.toArray()).sort((a, b) => a.name.localeCompare(b.name)),
    [db],
    EMPTY_VILLAGES,
  );

  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [weightMode, setWeightMode] = useState<WeightMode>('manual');
  const [scaleReading, setScaleReading] = useState<ScaleReading | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<MessageKey | null>(null);

  const today = todayIST();

  // Parse the typed numbers, then run the shared validator on the draft.
  const { valid, errors, value } = useMemo(() => {
    const parseErrors: FieldErrors<MotherField> = {};
    const age = parseIntegerInput(form.age);
    if (!age.ok) parseErrors.age = age.error;
    const height = parseNumberInput(form.height_cm);
    if (!height.ok) parseErrors.height_cm = height.error;

    let weightKg: number | null = null;
    if (weightMode === 'manual') {
      const w = parseNumberInput(form.weight);
      if (!w.ok) parseErrors.first_weight_kg = w.error;
      else weightKg = w.value;
    } else {
      weightKg = scaleReading?.weightKg ?? null;
    }

    const result = validateMotherDraft({
      full_name: form.full_name,
      age: age.ok ? age.value : null,
      guardian_name: form.guardian_name,
      village_id: form.village_id,
      phone: form.phone,
      lmp_date: form.lmp_date === '' ? null : form.lmp_date,
      is_bpl: form.is_bpl,
      height_cm: height.ok ? height.value : null,
      first_weight_kg: weightKg,
    });
    const merged: FieldErrors<MotherField> = { ...result.errors, ...parseErrors };
    const ok = result.ok && Object.keys(parseErrors).length === 0;
    return { valid: ok, errors: merged, value: ok ? result.value : null };
  }, [form, weightMode, scaleReading]);

  // Live GA / EDD preview for a valid LMP that is not in the future.
  const preview = useMemo(() => {
    if (!isStrictIsoDate(form.lmp_date) || form.lmp_date > today) return null;
    const ga = gaDays(form.lmp_date, today);
    return { ga: gaLabel(ga), edd: eddNaegele(form.lmp_date) };
  }, [form.lmp_date, today]);

  const set = <K extends keyof FormState>(key: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: v }));
    setSaveError(null);
  };
  const touch = (field: FormField) => setTouched((s) => (s[field] ? s : { ...s, [field]: true }));

  const fieldId = (field: FormField) => `${uid}-${field}`;
  const errorId = (field: FormField) => `${uid}-${field}-error`;
  const shownError = (field: FormField): MessageKey | null =>
    touched[field] ? (errors[field] ?? null) : null;

  /** Props linking an input to its inline error. */
  const a11y = (field: FormField) => {
    const err = shownError(field);
    return {
      id: fieldId(field),
      'aria-invalid': err ? true : undefined,
      'aria-describedby': err ? errorId(field) : undefined,
      onBlur: () => touch(field),
    } as const;
  };

  const errorText = (field: FormField) => {
    const err = shownError(field);
    return err ? (
      <p id={errorId(field)} className="form-error">
        {t(err)}
      </p>
    ) : null;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !value || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const row = await saveMother(db, {
        full_name: value.full_name,
        age: value.age,
        guardian_name: value.guardian_name,
        village_id: value.village_id,
        phone: value.phone ?? null,
        lmp_date: value.lmp_date,
        is_bpl: value.is_bpl,
        height_cm: value.height_cm ?? null,
        first_weight_kg: value.first_weight_kg ?? null,
      });
      navigate(motherPath(row.id), { state: { saved: true } });
    } catch (err) {
      console.warn('could not save mother', err);
      setSaveError('field.error.saveFailed');
      setSaving(false);
    }
  };

  const takeReading = (r: ScaleReading) => {
    setScaleReading(r);
    touch('first_weight_kg');
  };

  const chooseMode = (mode: WeightMode) => {
    setWeightMode(mode);
    setScaleReading(null);
    touch('first_weight_kg');
  };

  return (
    <section className="field-screen register-mother" aria-labelledby="register-title">
      <h1 id="register-title">{t('field.register.title')}</h1>

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="form-field">
          <label htmlFor={fieldId('full_name')}>{t('field.register.fullName')}</label>
          <input
            {...a11y('full_name')}
            type="text"
            name="full_name"
            autoComplete="off"
            required
            maxLength={120}
            value={form.full_name}
            onChange={(e) => {
              set('full_name', e.target.value);
              touch('full_name');
            }}
          />
          {errorText('full_name')}
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('age')}>{t('field.register.age')}</label>
          <input
            {...a11y('age')}
            type="text"
            inputMode="numeric"
            name="age"
            autoComplete="off"
            required
            value={form.age}
            onChange={(e) => {
              set('age', e.target.value);
              touch('age');
            }}
          />
          {errorText('age')}
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('guardian_name')}>{t('field.register.guardianName')}</label>
          <input
            {...a11y('guardian_name')}
            type="text"
            name="guardian_name"
            autoComplete="off"
            required
            maxLength={120}
            value={form.guardian_name}
            onChange={(e) => {
              set('guardian_name', e.target.value);
              touch('guardian_name');
            }}
          />
          {errorText('guardian_name')}
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('village_id')}>{t('field.register.village')}</label>
          <select
            {...a11y('village_id')}
            name="village_id"
            required
            value={form.village_id}
            onChange={(e) => {
              set('village_id', e.target.value);
              touch('village_id');
            }}
          >
            <option value="">{t('field.register.villagePlaceholder')}</option>
            {villages.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          {errorText('village_id')}
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('phone')}>{t('field.register.phone')}</label>
          <input
            {...a11y('phone')}
            type="tel"
            inputMode="numeric"
            name="phone"
            autoComplete="off"
            maxLength={10}
            value={form.phone}
            onChange={(e) => {
              set('phone', e.target.value);
              touch('phone');
            }}
          />
          {errorText('phone')}
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('lmp_date')}>{t('field.register.lmp')}</label>
          <input
            {...a11y('lmp_date')}
            type="date"
            name="lmp_date"
            required
            max={today}
            value={form.lmp_date}
            onChange={(e) => {
              set('lmp_date', e.target.value);
              touch('lmp_date');
            }}
          />
          {errorText('lmp_date')}
          <div className="register-mother__preview" aria-live="polite" data-testid="ga-preview">
            {preview ? (
              <>
                <p>{t('field.register.gaPreview', { ga: preview.ga })}</p>
                <p>{t('field.register.eddPreview', { edd: preview.edd })}</p>
              </>
            ) : null}
          </div>
        </div>

        <div className="form-field form-field--check">
          <label htmlFor={`${uid}-is_bpl`} className="check-label">
            <input
              id={`${uid}-is_bpl`}
              type="checkbox"
              name="is_bpl"
              checked={form.is_bpl}
              onChange={(e) => set('is_bpl', e.target.checked)}
            />
            {t('field.register.bpl')}
          </label>
        </div>

        <div className="form-field">
          <label htmlFor={fieldId('height_cm')}>{t('field.register.height')}</label>
          <input
            {...a11y('height_cm')}
            type="text"
            inputMode="decimal"
            name="height_cm"
            autoComplete="off"
            value={form.height_cm}
            onChange={(e) => {
              set('height_cm', e.target.value);
              touch('height_cm');
            }}
          />
          {errorText('height_cm')}
        </div>

        <fieldset className="weight-block">
          <legend>{t('field.register.firstWeight')}</legend>
          <div className="weight-block__modes" role="group" aria-label={t('field.visit.weight')}>
            {(
              [
                ['manual', 'field.visit.typeManually'],
                ['simulated', 'field.visit.useSimulated'],
                ['ble', 'field.visit.useBle'],
              ] as const
            ).map(([mode, key]) => (
              <button
                key={mode}
                type="button"
                className={weightMode === mode ? 'btn btn--primary' : 'btn'}
                aria-pressed={weightMode === mode}
                onClick={() => chooseMode(mode)}
              >
                {t(key)}
              </button>
            ))}
          </div>

          {weightMode === 'manual' ? (
            <div className="form-field">
              <label htmlFor={fieldId('first_weight_kg')}>{t('field.visit.weightKg')}</label>
              <input
                {...a11y('first_weight_kg')}
                type="text"
                inputMode="decimal"
                name="first_weight_kg"
                autoComplete="off"
                value={form.weight}
                onChange={(e) => {
                  set('weight', e.target.value);
                  touch('first_weight_kg');
                }}
              />
              {errorText('first_weight_kg')}
            </div>
          ) : scaleReading && scaleReading.weightKg !== null ? (
            <div className="weight-block__reading">
              <p className="scale-kg" role="status">
                {t('field.register.weightFromScale', { w: scaleReading.weightKg.toFixed(2) })}
              </p>
              <button type="button" className="btn" onClick={() => setScaleReading(null)}>
                {t('field.visit.changeWeight')}
              </button>
            </div>
          ) : weightMode === 'simulated' ? (
            <SimulatedScale onUse={takeReading} />
          ) : (
            <BleScaleReader onUse={takeReading} onCancel={() => chooseMode('manual')} />
          )}
          {weightMode !== 'manual' ? errorText('first_weight_kg') : null}
        </fieldset>

        {saveError ? (
          <p className="form-error" role="alert">
            {t(saveError)}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn--primary btn--block"
          data-testid="register-save"
          disabled={!valid || saving}
        >
          {t('field.register.save')}
        </button>
      </form>
    </section>
  );
}

export default RegisterMother;
