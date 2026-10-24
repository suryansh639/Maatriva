/**
 * Pure helpers for the doctor's ActionForm, BirthOutcomeForm and OutcomesPanel
 * (Req 23.3, 23.6, 23.9, 24.2, 24.3, 24.5, 24.7, 24.8). English only (Req 32.6).
 *
 * The client checks mirror the server rules (backend `schemas.TaskCreateIn`,
 * `task_service.check_due_date`, `schemas.BirthOutcomeIn`,
 * `outcome_service.check_delivery_*`), so most mistakes are caught before a
 * request; the server stays authoritative and its errors are shown as well.
 */
import { isApiError } from '../shared/api';
import { addDays, isIsoDate } from '../shared/time';
import { ACTION_TYPES } from '../shared/types';
import type {
  ActionType,
  AlertOut,
  BirthOutcomeIn,
  BirthOutcomeKind,
  MotherDetailOut,
  TaskCreateIn,
} from '../shared/types';

// ------------------------------------------------------------------ constants (mirror backend)

/** `schemas.INSTRUCTIONS_MAX`. */
export const INSTRUCTIONS_MAX = 500;
/** `schemas.TASK_DUE_MAX_DAYS`: due date from today to today + 60. */
export const TASK_DUE_MAX_DAYS = 60;
/** Req 23.9: the due date defaults to today + 2 days. */
export const TASK_DUE_DEFAULT_DAYS = 2;
/** `schemas.DELIVERY_MIN_GA_DAYS`: delivery on or after LMP + 140 days (20 weeks). */
export const DELIVERY_MIN_GA_DAYS = 140;
/** Req 24.5: the outcome form is shown from GA 20 weeks. */
export const OUTCOME_FORM_MIN_GA_DAYS = 140;
export const BIRTH_WEIGHT_MIN = 0.3;
export const BIRTH_WEIGHT_MAX = 6.0;
/** Req 3.11: low birth weight is below 2.5 kg. */
export const LBW_THRESHOLD_KG = 2.5;
/** Req 24.7: `outcome_service.HB_IMPROVED_MIN_DELTA`. */
export const HB_IMPROVED_MIN_DELTA = 0.5;

/** Statuses of a live RED alert (`alert_router.LIVE_RED`). */
const LIVE_RED_STATUSES: ReadonlySet<AlertOut['status']> = new Set(['open', 'acknowledged', 'actioned']);

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ action form

export interface TaskFormValues {
  action_type: string;
  instructions: string;
  due_date: string;
  /** Linked alert id, or '' for "automatic" (the server links the live RED alert, Req 23.6). */
  alert_id: string;
}

export type TaskFormErrors = Partial<Record<'action_type' | 'instructions' | 'due_date', string>>;

export function defaultDueDate(today: string): string {
  return addDays(today, TASK_DUE_DEFAULT_DAYS);
}

export function maxDueDate(today: string): string {
  return addDays(today, TASK_DUE_MAX_DAYS);
}

/** The mother's live RED alert, newest first (the one the server would auto-link). */
export function liveRedAlert(alerts: readonly AlertOut[]): AlertOut | null {
  let best: AlertOut | null = null;
  for (const a of alerts) {
    if (a.severity !== 'RED' || !LIVE_RED_STATUSES.has(a.status)) continue;
    if (best === null || a.created_at > best.created_at) best = a;
  }
  return best;
}

export function initialTaskForm(today: string, alerts: readonly AlertOut[]): TaskFormValues {
  return {
    action_type: ACTION_TYPES[0],
    instructions: '',
    due_date: defaultDueDate(today),
    alert_id: liveRedAlert(alerts)?.id ?? '',
  };
}

/** Field errors for the action form (Req 23.3). Empty object means valid. */
export function validateTaskForm(values: TaskFormValues, today: string): TaskFormErrors {
  const errors: TaskFormErrors = {};
  if (!isActionType(values.action_type)) errors.action_type = 'Choose an action';

  const instructions = values.instructions.trim();
  if (instructions.length > INSTRUCTIONS_MAX) {
    errors.instructions = `Instructions can be at most ${INSTRUCTIONS_MAX} characters`;
  } else if (values.action_type === 'OTHER' && instructions.length === 0) {
    errors.instructions = 'Instructions are required for "Other action"';
  }

  if (!isIsoDate(values.due_date)) {
    errors.due_date = 'Enter a valid due date';
  } else if (values.due_date < today || values.due_date > maxDueDate(today)) {
    errors.due_date = `Due date must be from today to ${TASK_DUE_MAX_DAYS} days from today`;
  }
  return errors;
}

/** Request body; blank instructions and an "automatic" alert link are omitted. */
export function buildTaskCreate(values: TaskFormValues): TaskCreateIn {
  if (!isActionType(values.action_type)) throw new RangeError(`Unknown action type: ${values.action_type}`);
  const body: TaskCreateIn = { action_type: values.action_type, due_date: values.due_date };
  const instructions = values.instructions.trim();
  if (instructions) body.instructions = instructions;
  if (values.alert_id) body.alert_id = values.alert_id;
  return body;
}

/** Doctors may issue actions for active mothers only (Req 23.4, 23.9, 37.8). */
export function canIssueAction(detail: MotherDetailOut, isDoctor: boolean): boolean {
  return isDoctor && detail.mother.status === 'active' && detail.birth_outcome === null;
}

export interface FormErrorMessage {
  text: string;
  /** The detail is stale (alert closed, mother delivered, outcome exists): refetch it. */
  reload: boolean;
}

function commonError(err: unknown, verb: string): FormErrorMessage {
  if (isApiError(err)) {
    if (err.status === 403) return { text: 'Only doctors can do this.', reload: false };
    if (err.status === 404) return { text: 'Patient not found, or not in your facility.', reload: false };
    if (err.status === 422) return { text: `Not accepted: ${err.message}`, reload: false };
    return { text: `Could not ${verb}: ${err.message}`, reload: false };
  }
  return { text: `Could not ${verb} – check your connection and try again.`, reload: false };
}

/** User-facing message for a failed `POST /api/mothers/{id}/tasks`. */
export function taskErrorMessage(err: unknown): FormErrorMessage {
  if (isApiError(err)) {
    if (err.code === 'INVALID_ALERT') {
      return { text: 'The linked alert is no longer open. The page was refreshed – check the link and try again.', reload: true };
    }
    if (err.code === 'MOTHER_INACTIVE') {
      return { text: 'This mother has delivered, so new actions cannot be issued.', reload: true };
    }
  }
  return commonError(err, 'issue the action');
}

// ------------------------------------------------------------------ birth outcome form

export interface OutcomeFormValues {
  delivery_date: string;
  outcome: BirthOutcomeKind;
  /** Kilograms as typed; '' when empty. */
  birth_weight_kg: string;
}

export type OutcomeFormErrors = Partial<Record<'delivery_date' | 'birth_weight_kg', string>>;

export function minDeliveryDate(lmp: string): string {
  return addDays(lmp, DELIVERY_MIN_GA_DAYS);
}

export function initialOutcomeForm(today: string): OutcomeFormValues {
  return { delivery_date: today, outcome: 'live_birth', birth_weight_kg: '' };
}

/** Parsed weight, or null when empty or not a finite number. */
export function parseWeight(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function isLowBirthWeight(kg: number | null): boolean {
  return kg !== null && kg < LBW_THRESHOLD_KG;
}

/** Field errors for the outcome form (Req 24.2, 24.3). Empty object means valid. */
export function validateOutcomeForm(values: OutcomeFormValues, lmp: string, today: string): OutcomeFormErrors {
  const errors: OutcomeFormErrors = {};
  if (!isIsoDate(values.delivery_date)) {
    errors.delivery_date = 'Enter a valid delivery date';
  } else if (values.delivery_date > today) {
    errors.delivery_date = 'Delivery date cannot be after today';
  } else if (values.delivery_date < minDeliveryDate(lmp)) {
    errors.delivery_date = `Delivery date must be on or after ${minDeliveryDate(lmp)} (LMP + 20 weeks)`;
  }

  const text = values.birth_weight_kg.trim();
  const kg = parseWeight(text);
  if (text && kg === null) {
    errors.birth_weight_kg = 'Enter the weight as a number in kg';
  } else if (kg === null) {
    if (values.outcome === 'live_birth') errors.birth_weight_kg = 'Birth weight is required for a live birth';
  } else if (kg < BIRTH_WEIGHT_MIN || kg > BIRTH_WEIGHT_MAX) {
    errors.birth_weight_kg = `Birth weight must be ${BIRTH_WEIGHT_MIN} to ${BIRTH_WEIGHT_MAX.toFixed(1)} kg`;
  }
  return errors;
}

export function buildBirthOutcome(values: OutcomeFormValues): BirthOutcomeIn {
  const body: BirthOutcomeIn = { delivery_date: values.delivery_date, outcome: values.outcome };
  const kg = parseWeight(values.birth_weight_kg);
  if (kg !== null) body.birth_weight_kg = kg;
  return body;
}

/** Doctors only, GA of at least 20 weeks, no outcome yet, mother still active (Req 24.5). */
export function canRecordOutcome(detail: MotherDetailOut, isDoctor: boolean): boolean {
  return (
    isDoctor &&
    detail.birth_outcome === null &&
    detail.mother.status === 'active' &&
    detail.ga_days >= OUTCOME_FORM_MIN_GA_DAYS
  );
}

/** User-facing message for a failed `POST /api/mothers/{id}/birth-outcome`. */
export function outcomeErrorMessage(err: unknown): FormErrorMessage {
  if (isApiError(err)) {
    if (err.code === 'ALREADY_RECORDED') {
      return { text: 'A birth outcome is already recorded for this mother. The page was refreshed.', reload: true };
    }
    if (err.code === 'MOTHER_INACTIVE') {
      return { text: 'This mother is already marked delivered. The page was refreshed.', reload: true };
    }
  }
  return commonError(err, 'record the outcome');
}
