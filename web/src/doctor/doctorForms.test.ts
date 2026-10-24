/**
 * Doctor action / birth outcome forms and the outcomes panel
 * (Requirements 23.3, 23.6, 23.9, 24.2, 24.3, 24.5, 24.8, 37.8).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../shared/api';
import type { AlertOut, MotherDetailOut } from '../shared/types';
import { ActionForm } from './ActionForm';
import { BirthOutcomeForm } from './BirthOutcomeForm';
import {
  buildBirthOutcome,
  buildTaskCreate,
  canIssueAction,
  canRecordOutcome,
  defaultDueDate,
  initialTaskForm,
  isLowBirthWeight,
  liveRedAlert,
  outcomeErrorMessage,
  taskErrorMessage,
  validateOutcomeForm,
  validateTaskForm,
} from './doctorForms';
import type { OutcomeFormValues, TaskFormValues } from './doctorForms';
import { HB_IMPROVED_EXPLANATION, OutcomesView } from './OutcomesPanel';
import { defaultPatientActions } from './PatientDetail';

const M = '00000000-0000-4000-8000-000000000001';
const TODAY = '2025-03-10';
const LMP = '2024-09-01'; // GA on TODAY = 190 days

function alert(over: Partial<AlertOut> = {}): AlertOut {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    mother_id: M,
    mother_name: 'Sunita Demo (synthetic)',
    village_name: 'Dankaur',
    recipient_role: 'doctor',
    severity: 'RED',
    status: 'open',
    flag_codes: ['HB_SEVERE'],
    summary: 'Severe anaemia',
    reasons: ['Hb 6.8 g/dL is below 7.0'],
    created_at: '2025-03-09T04:30:00Z',
    updated_at: null,
    acknowledged_at: null,
    closed_at: null,
    ...over,
  };
}

function detail(over: { alerts?: AlertOut[]; ga_days?: number; status?: 'active' | 'delivered' } = {}): MotherDetailOut {
  return {
    mother: {
      id: M,
      full_name: 'Sunita Demo (synthetic)',
      age: 24,
      guardian_name: 'Ramesh',
      village_id: 'v1',
      phone: null,
      lmp_date: LMP,
      edd_date: '2025-06-08',
      is_bpl: true,
      height_cm: 152,
      first_weight_kg: 52,
      registered_at: '2024-10-10T03:30:00Z',
      updated_at: '2024-10-10T03:30:00Z',
      status: over.status ?? 'active',
      risk_level: 'RED',
      risk_updated_at: '2025-03-09T04:30:00Z',
      flags: [],
    },
    village: { id: 'v1', name: 'Dankaur', lat: 28.35, lng: 77.55 },
    asha: { id: 'u1', full_name: 'Asha One' },
    ga_days: over.ga_days ?? 190,
    visits: [],
    flags_active: [],
    flags_history: [],
    tasks: [],
    alerts: over.alerts ?? [alert()],
    birth_outcome: null,
  };
}

const noop = () => undefined;

describe('action form logic', () => {
  it('defaults the due date to today + 2 and pre-selects the live RED alert', () => {
    expect(defaultDueDate(TODAY)).toBe('2025-03-12');
    const v = initialTaskForm(TODAY, [alert()]);
    expect(v).toEqual({ action_type: 'HOME_VISIT_48H', instructions: '', due_date: '2025-03-12', alert_id: alert().id });
    expect(initialTaskForm(TODAY, []).alert_id).toBe('');
  });

  it('picks the newest live RED alert and ignores closed and AMBER ones', () => {
    const closed = alert({ id: 'closed', status: 'closed', created_at: '2025-03-10T01:00:00Z' });
    const amber = alert({ id: 'amber', severity: 'AMBER', recipient_role: 'anm', created_at: '2025-03-10T02:00:00Z' });
    const older = alert({ id: 'older', status: 'actioned', created_at: '2025-03-01T00:00:00Z' });
    const newer = alert({ id: 'newer', status: 'acknowledged', created_at: '2025-03-05T00:00:00Z' });
    expect(liveRedAlert([closed, amber, older, newer])?.id).toBe('newer');
    expect(liveRedAlert([closed, amber])).toBeNull();
  });

  it('validates the due date window today..today+60', () => {
    const base: TaskFormValues = { action_type: 'REPEAT_HB', instructions: '', due_date: TODAY, alert_id: '' };
    expect(validateTaskForm(base, TODAY)).toEqual({});
    expect(validateTaskForm({ ...base, due_date: '2025-05-09' }, TODAY)).toEqual({}); // today + 60
    expect(validateTaskForm({ ...base, due_date: '2025-05-10' }, TODAY).due_date).toBeDefined();
    expect(validateTaskForm({ ...base, due_date: '2025-03-09' }, TODAY).due_date).toBeDefined();
    expect(validateTaskForm({ ...base, due_date: '' }, TODAY).due_date).toBeDefined();
  });

  it('requires instructions for OTHER and caps them at 500 characters after trimming', () => {
    const base: TaskFormValues = { action_type: 'OTHER', instructions: '   ', due_date: TODAY, alert_id: '' };
    expect(validateTaskForm(base, TODAY).instructions).toBeDefined();
    expect(validateTaskForm({ ...base, instructions: 'Check ration card' }, TODAY)).toEqual({});
    expect(validateTaskForm({ ...base, instructions: ` ${'x'.repeat(500)} ` }, TODAY)).toEqual({});
    expect(validateTaskForm({ ...base, instructions: 'x'.repeat(501) }, TODAY).instructions).toBeDefined();
    expect(validateTaskForm({ ...base, action_type: 'NOPE', instructions: 'x' }, TODAY).action_type).toBeDefined();
  });

  it('builds the request body, omitting blank instructions and an automatic link', () => {
    expect(buildTaskCreate({ action_type: 'HOME_VISIT_48H', instructions: '  ', due_date: '2025-03-12', alert_id: '' })).toEqual({
      action_type: 'HOME_VISIT_48H',
      due_date: '2025-03-12',
    });
    expect(buildTaskCreate({ action_type: 'OTHER', instructions: ' Visit ', due_date: '2025-03-12', alert_id: 'a1' })).toEqual({
      action_type: 'OTHER',
      instructions: 'Visit',
      due_date: '2025-03-12',
      alert_id: 'a1',
    });
  });

  it('maps server errors, refreshing on stale state', () => {
    expect(taskErrorMessage(new ApiError(422, 'INVALID_ALERT', 'x')).reload).toBe(true);
    expect(taskErrorMessage(new ApiError(409, 'MOTHER_INACTIVE', 'x'))).toMatchObject({ reload: true });
    expect(taskErrorMessage(new ApiError(422, 'VALIDATION_ERROR', 'due_date: bad'))).toEqual({
      text: 'Not accepted: due_date: bad',
      reload: false,
    });
    expect(taskErrorMessage(new TypeError('Failed to fetch')).text).toMatch(/connection/);
  });

  it('allows actions for doctors on active mothers only', () => {
    expect(canIssueAction(detail(), true)).toBe(true);
    expect(canIssueAction(detail(), false)).toBe(false);
    expect(canIssueAction(detail({ status: 'delivered' }), true)).toBe(false);
  });
});

describe('birth outcome logic', () => {
  const base: OutcomeFormValues = { delivery_date: TODAY, outcome: 'live_birth', birth_weight_kg: '2.9' };

  it('bounds the delivery date to LMP + 140 days .. today', () => {
    expect(validateOutcomeForm(base, LMP, TODAY)).toEqual({});
    expect(validateOutcomeForm({ ...base, delivery_date: '2025-01-19' }, LMP, TODAY)).toEqual({}); // LMP + 140
    expect(validateOutcomeForm({ ...base, delivery_date: '2025-01-18' }, LMP, TODAY).delivery_date).toBeDefined();
    expect(validateOutcomeForm({ ...base, delivery_date: '2025-03-11' }, LMP, TODAY).delivery_date).toBeDefined();
  });

  it('requires a 0.3–6.0 kg weight for a live birth only', () => {
    expect(validateOutcomeForm({ ...base, birth_weight_kg: '' }, LMP, TODAY).birth_weight_kg).toBeDefined();
    expect(validateOutcomeForm({ ...base, outcome: 'stillbirth', birth_weight_kg: '' }, LMP, TODAY)).toEqual({});
    expect(validateOutcomeForm({ ...base, birth_weight_kg: '0.3' }, LMP, TODAY)).toEqual({});
    expect(validateOutcomeForm({ ...base, birth_weight_kg: '6' }, LMP, TODAY)).toEqual({});
    expect(validateOutcomeForm({ ...base, birth_weight_kg: '0.29' }, LMP, TODAY).birth_weight_kg).toBeDefined();
    expect(validateOutcomeForm({ ...base, birth_weight_kg: '6.01' }, LMP, TODAY).birth_weight_kg).toBeDefined();
    expect(validateOutcomeForm({ ...base, outcome: 'stillbirth', birth_weight_kg: '9' }, LMP, TODAY).birth_weight_kg).toBeDefined();
    expect(validateOutcomeForm({ ...base, birth_weight_kg: 'abc' }, LMP, TODAY).birth_weight_kg).toBeDefined();
  });

  it('flags low birth weight below 2.5 kg and builds the body', () => {
    expect(isLowBirthWeight(2.49)).toBe(true);
    expect(isLowBirthWeight(2.5)).toBe(false);
    expect(isLowBirthWeight(null)).toBe(false);
    expect(buildBirthOutcome(base)).toEqual({ delivery_date: TODAY, outcome: 'live_birth', birth_weight_kg: 2.9 });
    expect(buildBirthOutcome({ ...base, outcome: 'stillbirth', birth_weight_kg: '' })).toEqual({
      delivery_date: TODAY,
      outcome: 'stillbirth',
    });
  });

  it('shows the form to doctors from GA 20 weeks, and handles ALREADY_RECORDED', () => {
    expect(canRecordOutcome(detail({ ga_days: 140 }), true)).toBe(true);
    expect(canRecordOutcome(detail({ ga_days: 139 }), true)).toBe(false);
    expect(canRecordOutcome(detail(), false)).toBe(false);
    expect(outcomeErrorMessage(new ApiError(409, 'ALREADY_RECORDED', 'x')).reload).toBe(true);
  });
});

describe('form rendering', () => {
  it('renders the action form with the presets, defaults and the pre-selected alert', () => {
    const html = renderToStaticMarkup(
      createElement(ActionForm, { detail: detail(), today: TODAY, isDoctor: true, reload: noop }),
    );
    expect(html).toContain('>Action</label>');
    expect(html).toMatch(/<option value="HOME_VISIT_48H" selected="">Home visit within 48 hours<\/option>/);
    expect((html.match(/<option value="[A-Z_0-9]+"/g) ?? []).length).toBe(8);
    expect(html).toContain('value="2025-03-12"');
    expect(html).toContain(`<option value="${alert().id}" selected="">Open RED alert raised`);
    expect(html).toContain('>Issue action</button>');
  });

  it('renders no forms for ANMs, and no outcome form below 20 weeks', () => {
    expect(renderToStaticMarkup(createElement(ActionForm, { detail: detail(), today: TODAY, isDoctor: false, reload: noop }))).toBe('');
    expect(defaultPatientActions({ detail: detail(), today: TODAY, isDoctor: false, reload: noop })).toBeNull();
    expect(
      renderToStaticMarkup(createElement(BirthOutcomeForm, { detail: detail({ ga_days: 139 }), today: TODAY, isDoctor: true, reload: noop })),
    ).toBe('');
    const html = renderToStaticMarkup(
      createElement(BirthOutcomeForm, { detail: detail(), today: TODAY, isDoctor: true, reload: noop }),
    );
    expect(html).toContain('Record birth outcome');
    expect(html).toContain('min="2025-01-19"');
  });

  it('renders the outcome counts with the 0.5 g/dL explanation', () => {
    const html = renderToStaticMarkup(
      createElement(OutcomesView, {
        outcomes: {
          hb_improved_after_action: 2,
          mothers_with_action_and_followup_hb: 3,
          births_recorded: 10,
          lbw_count: 2,
          live_births: 10,
        },
      }),
    );
    expect(html).toContain('Hb improved after action');
    expect(html).toMatch(/2 of 3/);
    expect(HB_IMPROVED_EXPLANATION).toContain('0.5 g/dL');
    expect(html).toContain('0.5 g/dL');
  });
});
