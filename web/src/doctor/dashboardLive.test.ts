/**
 * Dashboard live-update helpers and the triage queue view (Requirements 19.8, 19.9, 21.4, 21.5).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertOut, QueueRowOut, TaskOut } from '../shared/types';
import type { LiveEvent } from './live/useLiveEvents';
import {
  alertIdsKey,
  alertToastMessage,
  createRefetchScheduler,
  DASHBOARD_REFETCH_DEBOUNCE_MS,
  isResolvedSinceAlert,
  liveStatusText,
  promoteAlertInQueue,
  refetchTargetsFor,
  toastForEvent,
  topReason,
} from './dashboardLive';
import type { RefetchTarget } from './dashboardLive';
import { patientPath, TriageQueue } from './TriageQueue';

const DEMO = '00000000-0000-4000-8000-000000000001';

function alert(over: Partial<AlertOut> = {}): AlertOut {
  return {
    id: 'a1',
    mother_id: DEMO,
    mother_name: 'Sunita Demo (synthetic)',
    village_name: 'Dankaur',
    recipient_role: 'doctor',
    severity: 'RED',
    status: 'open',
    flag_codes: ['HB_SEVERE', 'WEIGHT_LOSS'],
    summary: 'Hb 6.8 g/dL < 7.0; weight down 1.4 kg',
    reasons: ['Hb 6.8 g/dL < 7.0', 'Weight down 1.4 kg'],
    created_at: '2025-03-01T06:00:00Z',
    updated_at: '2025-03-01T06:00:00Z',
    acknowledged_at: null,
    closed_at: null,
    ...over,
  };
}

function row(over: Partial<QueueRowOut> & Pick<QueueRowOut, 'mother_id'>): QueueRowOut {
  return {
    full_name: `Mother ${over.mother_id.slice(0, 4)} (synthetic)`,
    guardian_name: 'Guardian',
    village_id: 'v1',
    village_name: 'Dankaur',
    is_bpl: false,
    ga_days: 180,
    edd_date: '2025-06-01',
    risk_level: 'GREEN',
    flags: [],
    last_visit_date: '2025-02-01',
    open_alert_id: null,
    open_alert_status: null,
    open_task_count: 0,
    risk_updated_at: null,
    ...over,
  };
}

const task = { id: 't1', mother_id: DEMO } as TaskOut;

const ev = {
  hello: { type: 'hello', id: '', data: { server_time: '2025-03-01T06:00:00Z' } },
  created: { type: 'alert.created', id: 'a1', data: { alert: alert() } },
  updatedNew: { type: 'alert.updated', id: 'a1', data: { alert: alert(), new_codes: ['BP_SEVERE'] } },
  updatedStatus: { type: 'alert.updated', id: 'a1', data: { alert: alert({ status: 'acknowledged' }), new_codes: [] } },
  risk: { type: 'risk.changed', id: '', data: { mother_id: DEMO, risk_level: 'RED' } },
  done: { type: 'task.done', id: 't1', data: { task, mother_name: 'Sunita Demo (synthetic)' } },
} satisfies Record<string, LiveEvent>;

describe('refetchTargetsFor (design §17 table)', () => {
  it.each<[keyof typeof ev, RefetchTarget[]]>([
    ['hello', []],
    ['created', ['queue', 'census']],
    ['updatedNew', ['queue']],
    ['updatedStatus', ['queue']],
    ['risk', ['queue', 'census']],
    ['done', ['queue']],
  ])('%s → %j', (name, expected) => {
    expect(refetchTargetsFor(ev[name])).toEqual(expected);
  });
});

describe('toastForEvent', () => {
  it('toasts a RED alert.created with the mother name, village and first reason', () => {
    expect(toastForEvent(ev.created)).toEqual({
      title: 'RED alert',
      message: 'Sunita Demo (synthetic) · Dankaur – Hb 6.8 g/dL < 7.0',
      motherId: DEMO,
    });
  });

  it('toasts alert.updated only when new_codes is non-empty', () => {
    expect(toastForEvent(ev.updatedNew)?.title).toBe('RED alert updated');
    expect(toastForEvent(ev.updatedStatus)).toBeNull();
  });

  it('does not toast other events or non-RED alerts', () => {
    expect(toastForEvent(ev.hello)).toBeNull();
    expect(toastForEvent(ev.risk)).toBeNull();
    expect(toastForEvent(ev.done)).toBeNull();
    const amber: LiveEvent = { type: 'alert.created', id: 'a2', data: { alert: alert({ severity: 'AMBER' }) } };
    expect(toastForEvent(amber)).toBeNull();
  });

  it('falls back to the summary, then to a generic text', () => {
    expect(alertToastMessage(alert({ reasons: [], village_name: null }))).toBe(
      'Sunita Demo (synthetic) – Hb 6.8 g/dL < 7.0; weight down 1.4 kg',
    );
    expect(alertToastMessage(alert({ reasons: [], summary: '', mother_name: null, village_name: null }))).toBe(
      'New RED alert',
    );
  });
});

describe('promoteAlertInQueue', () => {
  const rows = [
    row({ mother_id: 'aaaa-1', risk_level: 'RED' }),
    row({ mother_id: 'bbbb-2', risk_level: 'AMBER' }),
    row({ mother_id: DEMO, risk_level: 'GREEN' }),
    row({ mother_id: 'cccc-3' }),
  ];

  it('moves the mother to the top as RED with the alert linked, keeping the others in order', () => {
    const out = promoteAlertInQueue(rows, alert({ mother_id: DEMO.toUpperCase() }));
    expect(out.map((r) => r.mother_id)).toEqual([DEMO, 'aaaa-1', 'bbbb-2', 'cccc-3']);
    expect(out[0]).toMatchObject({ risk_level: 'RED', open_alert_id: 'a1', open_alert_status: 'open' });
    expect(rows[2].risk_level).toBe('GREEN');
  });

  it('returns the same list when the mother is not shown', () => {
    expect(promoteAlertInQueue(rows, alert({ mother_id: 'dddd-4' }))).toBe(rows);
  });
});

describe('row helpers', () => {
  it('isResolvedSinceAlert: a live RED alert on a row that is no longer RED (Req 21.5)', () => {
    expect(isResolvedSinceAlert({ open_alert_id: 'a1', risk_level: 'AMBER' })).toBe(true);
    expect(isResolvedSinceAlert({ open_alert_id: 'a1', risk_level: 'GREEN' })).toBe(true);
    expect(isResolvedSinceAlert({ open_alert_id: 'a1', risk_level: 'RED' })).toBe(false);
    expect(isResolvedSinceAlert({ open_alert_id: null, risk_level: 'GREEN' })).toBe(false);
  });

  it('topReason is the first flag reason', () => {
    expect(topReason({ flags: [] })).toBeNull();
    expect(
      topReason({
        flags: [
          { code: 'HB_SEVERE', severity: 'RED', reason: 'Hb 6.8' },
          { code: 'LATE_REG', severity: 'AMBER', reason: 'late' },
        ],
      }),
    ).toBe('Hb 6.8');
  });

  it('alertIdsKey ignores order', () => {
    expect(alertIdsKey([{ id: 'b' }, { id: 'a' }])).toBe(alertIdsKey([{ id: 'a' }, { id: 'b' }]));
    expect(alertIdsKey([{ id: 'a' }])).not.toBe(alertIdsKey([{ id: 'a' }, { id: 'b' }]));
  });

  it('liveStatusText', () => {
    expect(liveStatusText({ mode: 'sse', status: 'live' })).toBe('Live');
    expect(liveStatusText({ mode: 'sse', status: 'reconnecting' })).toMatch(/^Reconnecting/);
    expect(liveStatusText({ mode: 'sse', status: 'offline' })).toMatch(/^Offline/);
    expect(liveStatusText({ mode: 'poll', status: 'idle' })).toBe('Auto-refresh every 30 s');
    expect(liveStatusText({ mode: 'none', status: 'idle' })).toBe('');
  });
});

describe('createRefetchScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces and coalesces targets into one flush', () => {
    const flush = vi.fn<(t: ReadonlySet<RefetchTarget>) => void>();
    const s = createRefetchScheduler(flush);
    s.schedule(['queue']);
    vi.advanceTimersByTime(DASHBOARD_REFETCH_DEBOUNCE_MS - 1);
    s.schedule(['census', 'queue']);
    vi.advanceTimersByTime(DASHBOARD_REFETCH_DEBOUNCE_MS - 1);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect([...flush.mock.calls[0][0]].sort()).toEqual(['census', 'queue']);
    vi.advanceTimersByTime(DASHBOARD_REFETCH_DEBOUNCE_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('ignores empty schedules and drops pending work on cancel', () => {
    const flush = vi.fn();
    const s = createRefetchScheduler(flush);
    s.schedule([]);
    vi.advanceTimersByTime(DASHBOARD_REFETCH_DEBOUNCE_MS);
    expect(flush).not.toHaveBeenCalled();
    s.schedule(['queue']);
    s.cancel();
    vi.advanceTimersByTime(DASHBOARD_REFETCH_DEBOUNCE_MS);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('TriageQueue view', () => {
  const villages = [
    { id: 'v1', name: 'Dankaur' },
    { id: 'v2', name: 'Dadri' },
  ];
  const render = (rows: QueueRowOut[] | null, opts: { loading?: boolean; error?: string | null } = {}) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TriageQueue, {
          queue: { rows, loading: opts.loading ?? false, error: opts.error ?? null, reload: () => undefined },
          villages,
          villageId: null,
          onVillageChange: () => undefined,
          risk: null,
          onRiskChange: () => undefined,
        }),
      ),
    );

  it('renders each row with chip, link, GA, reason, alert status, resolved tag and an Open button', () => {
    const html = render([
      row({
        mother_id: DEMO,
        full_name: 'Sunita Demo (synthetic)',
        risk_level: 'RED',
        is_bpl: true,
        ga_days: 183,
        flags: [{ code: 'HB_SEVERE', severity: 'RED', reason: 'Hb 6.8 g/dL < 7.0' }],
        open_alert_id: 'a1',
        open_alert_status: 'open',
        open_task_count: 2,
      }),
      row({ mother_id: 'bbbb-2', risk_level: 'AMBER', open_alert_id: 'a9', open_alert_status: 'actioned' }),
    ]);
    expect(html).toContain('data-risk="RED"');
    expect(html).toContain(`href="${patientPath(DEMO)}"`);
    expect(html).toContain('Sunita Demo (synthetic)');
    expect(html).toContain('26w 1d');
    expect(html).toContain('Hb 6.8 g/dL &lt; 7.0');
    expect(html).toContain('BPL');
    expect(html).toContain('aria-label="Open Sunita Demo (synthetic)"');
    expect(html.match(/Resolved since alert/g)).toHaveLength(1);
    expect(html).toContain('Actioned');
    expect(html).toContain('<label class="triage-queue__filter"><span>Village</span><select');
    expect(html).toContain('<option value="v2">Dadri</option>');
  });

  it('shows loading, empty and error states', () => {
    expect(render(null, { loading: true })).toContain('Loading triage queue…');
    expect(render([])).toContain('No active pregnancies in this facility.');
    expect(render(null, { error: 'Boom' })).toContain('role="alert"');
  });
});
