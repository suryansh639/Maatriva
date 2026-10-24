/**
 * Doctor action form on the patient page (Req 23.9, 23.10, 37.8). English only.
 *
 * - Rendered for doctors and active (not delivered) mothers only; for anyone else
 *   it renders nothing (ANM read-only) or a short note (delivered mother).
 * - Fields: action preset, instructions (≤ 500, required for "Other action"),
 *   due date (today..today + 60, default today + 2) and the alert link. The live
 *   RED alert is pre-selected; "Automatic" omits `alert_id`, and the server then
 *   links the live RED alert anyway when there is one (Req 23.6).
 * - Submit "Issue action" → `POST /api/mothers/{id}/tasks`. On success the new
 *   task is announced with status "open" and the detail is reloaded; server
 *   errors (422 VALIDATION_ERROR / INVALID_ALERT, 409 MOTHER_INACTIVE) are shown.
 */
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { actionLabel } from '../shared/i18n';
import { formatIstHHMM, istDate, parseIsoZ } from '../shared/time';
import { ACTION_TYPES } from '../shared/types';
import type { MotherDetailOut, TaskOut } from '../shared/types';
import { createTask } from './doctorApi';
import {
  INSTRUCTIONS_MAX,
  buildTaskCreate,
  canIssueAction,
  initialTaskForm,
  liveRedAlert,
  maxDueDate,
  taskErrorMessage,
  validateTaskForm,
} from './doctorForms';
import type { TaskFormErrors, TaskFormValues } from './doctorForms';

export interface ActionFormProps {
  detail: MotherDetailOut;
  /** IST date today ("YYYY-MM-DD"). */
  today: string;
  isDoctor: boolean;
  /** Refetch the patient detail. */
  reload: () => void;
  /** Called with the created task (after `reload`). */
  onCreated?: (task: TaskOut) => void;
}

function raisedAt(iso: string): string {
  const ms = parseIsoZ(iso);
  return Number.isFinite(ms) ? `${istDate(ms)} ${formatIstHHMM(ms)} IST` : iso;
}

export function ActionForm({ detail, today, isDoctor, reload, onCreated }: ActionFormProps) {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    action: `${uid}-action`,
    instructions: `${uid}-instructions`,
    instructionsHint: `${uid}-instructions-hint`,
    instructionsError: `${uid}-instructions-error`,
    due: `${uid}-due`,
    dueError: `${uid}-due-error`,
    alert: `${uid}-alert`,
  };
  const motherId = detail.mother.id;
  const liveAlert = liveRedAlert(detail.alerts);

  const [values, setValues] = useState<TaskFormValues>(() => initialTaskForm(today, detail.alerts));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Keep the alert link in step with the detail: pre-select the live RED alert,
  // and drop a link to an alert that is no longer live.
  const liveAlertId = liveAlert?.id ?? '';
  useEffect(() => {
    setValues((v) => (v.alert_id === liveAlertId ? v : { ...v, alert_id: liveAlertId }));
  }, [liveAlertId]);

  // A new mother (route change) starts from a fresh form.
  useEffect(() => {
    setValues(initialTaskForm(today, detail.alerts));
    setTouched(false);
    setMessage(null);
    // Only the mother id resets the form; `detail.alerts` and `today` change on reloads.
  }, [motherId]);

  if (!isDoctor) return null;
  if (!canIssueAction(detail, isDoctor)) {
    return (
      <section className="pd-form" aria-labelledby={ids.heading}>
        <h2 id={ids.heading}>Issue action to ASHA</h2>
        <p className="pd-empty">This mother has delivered – new actions cannot be issued.</p>
      </section>
    );
  }

  const errors: TaskFormErrors = validateTaskForm(values, today);
  const hasErrors = Object.keys(errors).length > 0;
  // Errors appear after the first submit attempt, then update live.
  const shownErrors: TaskFormErrors = touched ? errors : {};
  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) => {
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
      const task = await createTask(motherId, buildTaskCreate(values));
      setMessage({
        tone: 'ok',
        text: `Action issued: ${actionLabel('en', task.action_type)} – status ${task.status}, due ${task.due_date}.`,
      });
      setValues((v) => ({ ...v, instructions: '' }));
      setTouched(false);
      reload();
      onCreated?.(task);
    } catch (err) {
      const m = taskErrorMessage(err);
      setMessage({ tone: 'error', text: m.text });
      if (m.reload) reload();
    } finally {
      setBusy(false);
    }
  };

  const instructionsDescribedBy = [ids.instructionsHint, shownErrors.instructions ? ids.instructionsError : null]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="pd-form" aria-labelledby={ids.heading} data-testid="action-form">
      <h2 id={ids.heading}>Issue action to ASHA</h2>
      <p className="pd-form__intro">The action becomes a task for {detail.asha.full_name}.</p>
      <form onSubmit={(ev) => void onSubmit(ev)} noValidate>
        <div className="pd-field">
          <label htmlFor={ids.action}>Action</label>
          <select
            id={ids.action}
            name="action_type"
            data-testid="action-type"
            value={values.action_type}
            onChange={(e) => set('action_type', e.target.value)}
          >
            {ACTION_TYPES.map((code) => (
              <option key={code} value={code}>
                {actionLabel('en', code)}
              </option>
            ))}
          </select>
        </div>

        <div className="pd-field">
          <label htmlFor={ids.instructions}>
            Instructions{values.action_type === 'OTHER' ? ' (required)' : ' (optional)'}
          </label>
          <textarea
            id={ids.instructions}
            name="instructions"
            data-testid="action-instructions"
            rows={3}
            maxLength={INSTRUCTIONS_MAX}
            value={values.instructions}
            aria-invalid={shownErrors.instructions ? true : undefined}
            aria-describedby={instructionsDescribedBy}
            aria-required={values.action_type === 'OTHER' ? true : undefined}
            onChange={(e) => set('instructions', e.target.value)}
          />
          <p id={ids.instructionsHint} className="pd-field__hint">
            {values.instructions.trim().length}/{INSTRUCTIONS_MAX} characters
          </p>
          {shownErrors.instructions ? (
            <p id={ids.instructionsError} className="form-error">
              {shownErrors.instructions}
            </p>
          ) : null}
        </div>

        <div className="pd-field">
          <label htmlFor={ids.due}>Due date</label>
          <input
            id={ids.due}
            name="due_date"
            type="date"
            data-testid="action-due-date"
            min={today}
            max={maxDueDate(today)}
            required
            value={values.due_date}
            aria-invalid={shownErrors.due_date ? true : undefined}
            aria-describedby={shownErrors.due_date ? ids.dueError : undefined}
            onChange={(e) => set('due_date', e.target.value)}
          />
          {shownErrors.due_date ? (
            <p id={ids.dueError} className="form-error">
              {shownErrors.due_date}
            </p>
          ) : null}
        </div>

        <div className="pd-field">
          <label htmlFor={ids.alert}>Link to alert</label>
          <select
            id={ids.alert}
            name="alert_id"
            data-testid="action-alert"
            value={values.alert_id}
            onChange={(e) => set('alert_id', e.target.value)}
          >
            {liveAlert ? (
              <option value={liveAlert.id}>
                Open RED alert raised {raisedAt(liveAlert.created_at)} ({liveAlert.status})
              </option>
            ) : null}
            <option value="">{liveAlert ? 'Automatic (links the open RED alert)' : 'No open RED alert – not linked'}</option>
          </select>
        </div>

        <button type="submit" className="btn btn--primary" disabled={busy} data-testid="issue-action">
          {busy ? 'Issuing…' : 'Issue action'}
        </button>
        <div role="status" aria-live="polite" className="pd-form__status">
          {message ? <p className={message.tone === 'error' ? 'form-error' : 'pd-ok'}>{message.text}</p> : null}
        </div>
      </form>
    </section>
  );
}

export default ActionForm;
