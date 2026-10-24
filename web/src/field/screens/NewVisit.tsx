/**
 * New visit for one mother (Req 30.1–30.6, 29.7, 33.11).
 *
 * Fields: visit date (default today IST, at most tomorrow, not before LMP), a
 * weight block ("Use Bluetooth scale" / "Simulated scale" / "Type manually"), Hb
 * on a large numeric keypad (3.0–20.0, one decimal) with its source, BP
 * systolic/diastolic, IFA and calcium tablets, THR received yes/no and notes.
 *
 * Every change runs `validateVisitForm` (the client mirror of Requirement 11 with
 * this mother's LMP). Errors show inline, linked through `aria-describedby`, and
 * Save stays disabled while anything is invalid.
 *
 * Save:
 * - a `ble` / `simulated` reading first opens `MotherConfirm`; only "Yes, this is
 *   {name}" saves. "No, wrong mother" returns here unsaved and offers "Choose
 *   another mother", which opens `MotherPicker` and moves the whole unsaved form
 *   (reading included) to that mother's new-visit screen through router state;
 * - a manual-only visit saves directly.
 * `saveVisit` writes the row and its outbox entry in one transaction, storing
 * `weight_source` and `ble_raw_hex`; then the mother detail opens with a
 * "Visit saved" notice.
 *
 * Route: `/field/mother/:motherId/visit` (task 18.8 mounts it).
 *
 * E2E hooks (English names): "Simulated scale", "Demo preset (56.6 kg)", "Step on
 * scale", "Use this reading", the "Hb (g/dL)" input (`data-testid="hb-input"`,
 * keys `keypad-<key>`), "Save visit" (`visit-save`) and "Yes, this is {name}"
 * (`confirm-yes`).
 */
import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { useAuth } from '../../shared/auth';
import type { MessageKey } from '../../shared/i18n';
import { useI18n } from '../../shared/I18nProvider';
import { addDays, todayIST } from '../../shared/time';
import type { HbSource, LocalMother, LocalVisit } from '../../shared/types';
import BleScaleReader from '../ble/BleScaleReader';
import type { ScaleReading } from '../ble/scale';
// `SimulatedScalePanel.tsx`: `SimulatedScale.tsx` collided with `simulatedScale.ts`
// on case-insensitive file systems (Windows).
import SimulatedScale from '../ble/SimulatedScalePanel';
import { MotherConfirm, MotherPicker } from '../components/MotherConfirm';
import NumericKeypad from '../components/NumericKeypad';
import { saveVisit } from '../outbox';
import { FIELD_PATHS, motherPath, newVisitPath } from '../paths';
import { useSync } from '../sync/SyncProvider';
import { isStrictIsoDate, type VisitField } from '../validation';
import {
  initialVisitForm,
  lastWeightKg,
  needsMotherConfirm,
  readCarriedDraft,
  validateVisitForm,
  type CarriedVisitState,
  type ThrAnswer,
  type VisitFormState,
  type WeightMode,
} from '../visitForm';
import { useVillageNames } from './MothersList';
import '../components/visit.css';
import './mothers.css';

const EMPTY_VISITS: LocalVisit[] = [];
const EMPTY_MOTHERS: LocalMother[] = [];

/** Router state the mother detail reads for its "saved" notice. */
export interface SavedState {
  saved: 'visit';
}

export interface NewVisitProps {
  motherId?: string;
}

/** Loads the mother, then renders the form keyed by her id (a picked mother remounts it). */
export function NewVisit({ motherId: idProp }: NewVisitProps) {
  const { t } = useI18n();
  const { db } = useSync();
  const params = useParams<{ motherId: string }>();
  const motherId = (idProp ?? params.motherId ?? '').toLowerCase();

  const found = useLiveQuery(async () => ({ mother: (await db.mothers.get(motherId)) ?? null }), [db, motherId]);
  const mother = found?.mother ?? null;

  if (found === undefined) {
    return (
      <section className="field-screen">
        <p role="status">{t('field.common.loading')}</p>
      </section>
    );
  }

  if (!mother || mother.status === 'delivered') {
    return (
      <section className="field-screen" aria-labelledby="visit-title">
        <h1 id="visit-title">{t('field.detail.newVisit')}</h1>
        <p role="alert">{t(mother ? 'sync.code.MOTHER_INACTIVE' : 'field.detail.notFound')}</p>
        <Link to={mother ? motherPath(mother.id) : FIELD_PATHS.mothers} className="btn btn--link">
          {t('field.common.back')}
        </Link>
      </section>
    );
  }

  return <NewVisitForm key={mother.id} mother={mother} />;
}

type ErrorSlot = VisitField | 'bp' | 'weight';

function NewVisitForm({ mother }: { mother: LocalMother }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { db } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const uid = useId();

  const today = todayIST();
  // Read once: a form carried over from "Choose another mother".
  const [carried] = useState(() => readCarriedDraft(location.state));
  const [form, setForm] = useState<VisitFormState>(() => carried ?? initialVisitForm(today));
  const [touched, setTouched] = useState<Partial<Record<ErrorSlot, boolean>>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<MessageKey | null>(null);

  const villages = useVillageNames(db);
  const villageName = villages.get(mother.village_id) ?? '';
  const visits = useLiveQuery(
    () => db.visits.where('mother_id').equals(mother.id).toArray(),
    [db, mother.id],
    EMPTY_VISITS,
  );
  const allMothers = useLiveQuery(
    async () => (pickerOpen ? db.mothers.toArray() : EMPTY_MOTHERS),
    [db, pickerOpen],
    EMPTY_MOTHERS,
  );

  const lmpDate = isStrictIsoDate(mother.lmp_date) ? mother.lmp_date : null;
  const { valid, errors, draft } = useMemo(
    () => validateVisitForm(form, mother.id, { lmpDate }),
    [form, mother.id, lmpDate],
  );
  const lastKg = useMemo(() => lastWeightKg(mother, visits), [mother, visits]);

  // ---------------------------------------------------------------- helpers

  const update = (patch: Partial<VisitFormState>, ...slots: ErrorSlot[]) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaveError(null);
    setRejected(false);
    if (slots.length > 0) {
      setTouched((s) => {
        const next = { ...s };
        for (const slot of slots) next[slot] = true;
        return next;
      });
    }
  };
  const touch = (slot: ErrorSlot) => setTouched((s) => (s[slot] ? s : { ...s, [slot]: true }));

  const fieldId = (slot: ErrorSlot) => `${uid}-${slot}`;
  const errorId = (slot: ErrorSlot) => `${uid}-${slot}-error`;

  /** The message for one display slot; a few model rules land on hidden fields. */
  const slotError = (slot: ErrorSlot): MessageKey | null => {
    if (!touched[slot]) return null;
    if (slot === 'weight') return errors.weight_kg ?? errors.weight_source ?? errors.ble_raw_hex ?? null;
    if (slot === 'bp') return errors.bp_systolic ?? errors.bp_diastolic ?? errors.bp_source ?? null;
    return errors[slot] ?? null;
  };

  const a11y = (slot: ErrorSlot, inputSlot: ErrorSlot = slot) => {
    const err = slotError(slot);
    return {
      id: fieldId(inputSlot),
      'aria-invalid': err ? true : undefined,
      'aria-describedby': err ? errorId(slot) : undefined,
      onBlur: () => touch(slot),
    } as const;
  };

  const errorText = (slot: ErrorSlot) => {
    const err = slotError(slot);
    return err ? (
      <p id={errorId(slot)} className="form-error">
        {t(err)}
      </p>
    ) : null;
  };

  // ---------------------------------------------------------------- weight block

  const chooseMode = (mode: WeightMode) => update({ weightMode: mode, reading: null }, 'weight');
  const takeReading = (r: ScaleReading) => update({ reading: r }, 'weight');

  // ---------------------------------------------------------------- save

  const doSave = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveVisit(db, draft);
      const state: SavedState = { saved: 'visit' };
      navigate(motherPath(mother.id), { state });
    } catch (err) {
      console.warn('could not save visit', err);
      setSaveError('field.error.saveFailed');
      setSaving(false);
      setConfirmOpen(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !draft || saving) return;
    if (needsMotherConfirm(form)) {
      setRejected(false);
      setConfirmOpen(true);
    } else {
      void doSave();
    }
  };

  const pickMother = (otherId: string) => {
    const state: CarriedVisitState = { carriedDraft: form };
    setPickerOpen(false);
    navigate(newVisitPath(otherId), { replace: true, state });
  };

  // ---------------------------------------------------------------- render

  const deviceReading = form.weightMode !== 'manual' ? form.reading : null;

  return (
    <section className="field-screen new-visit" aria-labelledby="visit-title" data-mother-id={mother.id}>
      <Link to={motherPath(mother.id)} className="mother-detail__back">
        <span aria-hidden="true">← </span>
        {t('field.common.back')}
      </Link>
      <h1 id="visit-title">{t('field.visit.title', { name: mother.full_name })}</h1>

      {carried ? (
        <div className="new-visit__notice" role="status">
          <p>{t('field.visit.carried')}</p>
        </div>
      ) : null}

      <form onSubmit={onSubmit} noValidate>
        {/* Visit date */}
        <div className="form-field">
          <label htmlFor={fieldId('visit_date')}>{t('field.visit.date')}</label>
          <input
            {...a11y('visit_date')}
            type="date"
            name="visit_date"
            required
            min={lmpDate ?? undefined}
            max={addDays(today, 1)}
            value={form.visit_date}
            onChange={(e) => update({ visit_date: e.target.value }, 'visit_date')}
          />
          {errorText('visit_date')}
        </div>

        {/* Weight */}
        <fieldset className="weight-block">
          <legend>{t('field.visit.weight')}</legend>
          <div className="weight-block__modes" role="group" aria-label={t('field.visit.weight')}>
            {(
              [
                ['ble', 'field.visit.useBle'],
                ['simulated', 'field.visit.useSimulated'],
                ['manual', 'field.visit.typeManually'],
              ] as const
            ).map(([mode, key]) => (
              <button
                key={mode}
                type="button"
                className={form.weightMode === mode ? 'btn btn--primary' : 'btn'}
                aria-pressed={form.weightMode === mode}
                data-testid={`weight-mode-${mode}`}
                onClick={() => chooseMode(mode)}
              >
                {t(key)}
              </button>
            ))}
          </div>

          {form.weightMode === 'manual' ? (
            <div className="form-field">
              <label htmlFor={fieldId('weight')}>{t('field.visit.weightKg')}</label>
              <input
                {...a11y('weight')}
                type="text"
                inputMode="decimal"
                name="weight_kg"
                autoComplete="off"
                data-testid="weight-input"
                value={form.weight}
                onChange={(e) => update({ weight: e.target.value }, 'weight')}
              />
            </div>
          ) : deviceReading && deviceReading.weightKg !== null ? (
            <div className="weight-block__reading">
              <p className="scale-kg" role="status" data-testid="visit-scale-weight">
                {t('field.visit.weightFromScale', { w: deviceReading.weightKg.toFixed(2) })}
              </p>
              <button type="button" className="btn" onClick={() => update({ reading: null }, 'weight')}>
                {t('field.visit.changeWeight')}
              </button>
            </div>
          ) : form.weightMode === 'simulated' ? (
            <SimulatedScale lastWeightKg={lastKg} onUse={takeReading} />
          ) : (
            <BleScaleReader onUse={takeReading} onCancel={() => chooseMode('manual')} />
          )}
          {errorText('weight')}
        </fieldset>

        {/* Hb */}
        <NumericKeypad
          id={fieldId('hb_gdl')}
          label={t('field.visit.hb')}
          value={form.hb}
          onChange={(hb) => update({ hb }, 'hb_gdl')}
          onBlur={() => touch('hb_gdl')}
          maxDecimals={1}
          maxLength={4}
          describedBy={slotError('hb_gdl') ? errorId('hb_gdl') : undefined}
          invalid={Boolean(slotError('hb_gdl'))}
          testId="hb-input"
        />
        {errorText('hb_gdl')}

        <div className="form-field">
          <label htmlFor={fieldId('hb_source')}>{t('field.visit.hbSource')}</label>
          <select
            {...a11y('hb_source')}
            name="hb_source"
            data-testid="hb-source"
            value={form.hb_source}
            onChange={(e) => update({ hb_source: e.target.value as HbSource }, 'hb_source')}
          >
            <option value="manual">{t('field.visit.hbSourceManual')}</option>
            <option value="device">{t('field.visit.hbSourceDevice')}</option>
          </select>
          {errorText('hb_source')}
        </div>

        {/* BP: one error area for the pair (both-or-neither, order, ranges). */}
        <div className="new-visit__bp">
          <div className="form-field">
            <label htmlFor={fieldId('bp_systolic')}>{t('field.visit.bpSystolic')}</label>
            <input
              {...a11y('bp', 'bp_systolic')}
              type="text"
              inputMode="numeric"
              name="bp_systolic"
              autoComplete="off"
              data-testid="bp-systolic"
              value={form.bp_systolic}
              onChange={(e) => update({ bp_systolic: e.target.value }, 'bp')}
            />
          </div>
          <div className="form-field">
            <label htmlFor={fieldId('bp_diastolic')}>{t('field.visit.bpDiastolic')}</label>
            <input
              {...a11y('bp', 'bp_diastolic')}
              type="text"
              inputMode="numeric"
              name="bp_diastolic"
              autoComplete="off"
              data-testid="bp-diastolic"
              value={form.bp_diastolic}
              onChange={(e) => update({ bp_diastolic: e.target.value }, 'bp')}
            />
          </div>
        </div>
        {errorText('bp')}

        {/* Supplements */}
        <div className="form-field">
          <label htmlFor={fieldId('ifa_tablets')}>{t('field.visit.ifa')}</label>
          <input
            {...a11y('ifa_tablets')}
            type="text"
            inputMode="numeric"
            name="ifa_tablets"
            autoComplete="off"
            value={form.ifa_tablets}
            onChange={(e) => update({ ifa_tablets: e.target.value }, 'ifa_tablets')}
          />
          {errorText('ifa_tablets')}
        </div>
        <div className="form-field">
          <label htmlFor={fieldId('calcium_tablets')}>{t('field.visit.calcium')}</label>
          <input
            {...a11y('calcium_tablets')}
            type="text"
            inputMode="numeric"
            name="calcium_tablets"
            autoComplete="off"
            value={form.calcium_tablets}
            onChange={(e) => update({ calcium_tablets: e.target.value }, 'calcium_tablets')}
          />
          {errorText('calcium_tablets')}
        </div>

        <fieldset className="new-visit__radios">
          <legend>{t('field.visit.thr')}</legend>
          {(
            [
              ['yes', 'field.common.yes'],
              ['no', 'field.common.no'],
            ] as const
          ).map(([answer, key]) => (
            <label key={answer} className="check-label">
              <input
                type="radio"
                name="thr_received"
                value={answer}
                checked={form.thr === answer}
                onChange={() => update({ thr: answer as ThrAnswer })}
              />
              {t(key)}
            </label>
          ))}
        </fieldset>

        <div className="form-field">
          <label htmlFor={fieldId('notes')}>{t('field.visit.notes')}</label>
          <textarea
            {...a11y('notes')}
            name="notes"
            rows={3}
            value={form.notes}
            onChange={(e) => update({ notes: e.target.value }, 'notes')}
          />
          {errorText('notes')}
        </div>

        {rejected ? (
          <div className="new-visit__notice" role="status" data-testid="wrong-mother-notice">
            <p>{t('field.confirm.notSaved')}</p>
            <button
              type="button"
              className="btn"
              data-testid="choose-another"
              onClick={() => setPickerOpen(true)}
            >
              {t('field.confirm.chooseAnother')}
            </button>
          </div>
        ) : null}

        {saveError ? (
          <p className="form-error" role="alert">
            {t(saveError)}
          </p>
        ) : null}

        <button
          type="submit"
          className="btn btn--primary btn--block"
          data-testid="visit-save"
          disabled={!valid || saving}
        >
          {t('field.visit.save')}
        </button>
      </form>

      {confirmOpen ? (
        <MotherConfirm
          mother={mother}
          villageName={villageName}
          busy={saving}
          onConfirm={() => void doSave()}
          onReject={() => {
            setConfirmOpen(false);
            setRejected(true);
          }}
        />
      ) : null}

      {pickerOpen ? (
        <MotherPicker
          mothers={allMothers}
          excludeId={mother.id}
          villages={villages}
          username={user?.username}
          onPick={pickMother}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </section>
  );
}

export default NewVisit;
