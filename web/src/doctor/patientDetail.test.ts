/**
 * Patient detail helpers and the timeline view (Requirements 19.9, 22.3, 22.4, 22.6, 22.7).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AlertOut, TaskOut, VisitOut } from '../shared/types';
import type { LiveEvent } from './live/useLiveEvents';
import { bpSeries, hbSeries, paddedDomain, shouldRefetchDetail, supplementSeries, weightGainSeries } from './patientChartData';
import { buildTimeline } from './timeline';
// `.jsx` picks `Timeline.tsx` over `timeline.ts` on case-insensitive file systems.
import { formatTimelineTime, Timeline } from './Timeline.jsx';

const M = '00000000-0000-4000-8000-000000000001';
const OTHER = '11111111-1111-4111-8111-111111111111';

function visit(over: Partial<VisitOut> & Pick<VisitOut, 'id' | 'visit_date'>): VisitOut {
  return {
    mother_id: M,
    weight_kg: null,
    weight_source: null,
    ble_raw_hex: null,
    hb_gdl: null,
    hb_source: null,
    bp_systolic: null,
    bp_diastolic: null,
    bp_source: null,
    ifa_tablets: null,
    calcium_tablets: null,
    thr_received: null,
    notes: null,
    client_created_at: `${over.visit_date}T04:00:00Z`,
    recorded_by_id: 'asha',
    device_id: null,
    received_at: `${over.visit_date}T05:00:00Z`,
    ...over,
  };
}

function alert(over: Partial<AlertOut> = {}): AlertOut {
  return {
    id: 'a1',
    mother_id: M,
    mother_name: 'Sunita Demo (synthetic)',
    village_name: 'Dankaur',
    recipient_role: 'doctor',
    severity: 'RED',
    status: 'closed',
    flag_codes: ['HB_SEVERE'],
    summary: 'Hb 6.8 g/dL < 7.0',
    reasons: ['Hb 6.8 g/dL < 7.0'],
    created_at: '2025-03-01T06:00:00Z',
    updated_at: null,
    acknowledged_at: '2025-03-01T06:10:00Z',
    closed_at: '2025-03-02T08:00:00Z',
    ...over,
  };
}

function task(over: Partial<TaskOut> = {}): TaskOut {
  return {
    id: 't1',
    mother_id: M,
    alert_id: 'a1',
    action_type: 'HOME_VISIT_48H',
    instructions: null,
    due_date: '2025-03-03',
    status: 'done',
    is_overdue: false,
    issued_by_id: 'doc',
    issued_by_name: 'Dr Demo',
    asha_id: 'asha',
    created_at: '2025-03-01T06:20:00Z',
    done_at: '2025-03-02T08:00:00Z',
    done_note: 'Visited',
    ...over,
  };
}

describe('weightGainSeries', () => {
  const mother = { lmp_date: '2024-09-01', first_weight_kg: 50, height_cm: null };

  it('measures gain from first_weight_kg at GA weeks with a normal band when height is unknown', () => {
    const s = weightGainSeries(mother, [
      visit({ id: 'v2', visit_date: '2024-12-29', weight_kg: 54 }),
      visit({ id: 'v1', visit_date: '2024-11-24', weight_kg: 52.5 }),
    ]);
    expect(s.category).toBe('normal');
    expect(s.baselineKg).toBe(50);
    expect(s.visits.map((p) => [p.week, p.gain])).toEqual([
      [12, 2.5],
      [17, 4],
    ]);
    // Week 17, normal: 0.5 + 4 * 0.35 = 1.9 ; 2.0 + 4 * 0.5 = 4.0
    expect(s.visits[1].band).toEqual([1.9, 4]);
    // Band covers 0..40 weeks without duplicating visit weeks.
    const weeks = s.points.map((p) => p.week);
    expect(weeks[0]).toBe(0);
    expect(weeks[weeks.length - 1]).toBe(40);
    expect(new Set(weeks).size).toBe(weeks.length);
  });

  it('has no visit points when nothing was weighed', () => {
    const s = weightGainSeries({ ...mother, first_weight_kg: null }, [visit({ id: 'v1', visit_date: '2024-11-24' })]);
    expect(s.baselineKg).toBeNull();
    expect(s.visits).toEqual([]);
    expect(s.points.every((p) => p.gain === null)).toBe(true);
  });
});

describe('Hb, BP and supplement series', () => {
  const visits = [
    visit({ id: 'b', visit_date: '2025-02-01', hb_gdl: 9.5, bp_systolic: 150, bp_diastolic: 95, ifa_tablets: 30 }),
    visit({ id: 'a', visit_date: '2025-01-01', hb_gdl: 11.2, thr_received: true }),
    visit({
      id: 'c',
      visit_date: '2025-02-01',
      client_created_at: '2025-02-01T09:00:00Z',
      hb_gdl: 6.8,
      bp_systolic: 120,
    }),
  ];

  it('orders by visit date and labels repeat dates uniquely', () => {
    expect(hbSeries(visits).map((p) => [p.label, p.hb])).toEqual([
      ['2025-01-01', 11.2],
      ['2025-02-01', 9.5],
      ['2025-02-01 #2', 6.8],
    ]);
  });

  it('keeps only visits with both BP values', () => {
    expect(bpSeries(visits)).toEqual([{ label: '2025-02-01', date: '2025-02-01', systolic: 150, diastolic: 95 }]);
  });

  it('marks THR received and skips visits without supplement data', () => {
    expect(supplementSeries(visits).map((p) => [p.label, p.ifa, p.thr, p.thrMarker])).toEqual([
      ['2025-01-01', null, true, 0],
      ['2025-02-01', 30, null, null],
    ]);
  });

  it('pads the axis domain around values and reference lines', () => {
    expect(paddedDomain([6.8, 12.4], [7, 10, 11], 1)).toEqual([5, 14]);
  });
});

describe('shouldRefetchDetail', () => {
  const a = alert({ mother_id: M });
  const cases: Array<[LiveEvent, boolean]> = [
    [{ type: 'alert.created', id: '1', data: { alert: a } }, true],
    [{ type: 'alert.updated', id: '2', data: { alert: { ...a, mother_id: OTHER }, new_codes: [] } }, false],
    [{ type: 'risk.changed', id: '3', data: { mother_id: M.toUpperCase(), risk_level: 'RED' } }, true],
    [{ type: 'task.done', id: '4', data: { task: task(), mother_name: null } }, true],
    [{ type: 'task.done', id: '5', data: { task: task({ mother_id: OTHER }), mother_name: null } }, false],
    [{ type: 'hello', id: '', data: { server_time: '2025-03-01T00:00:00Z' } }, false],
  ];
  it.each(cases)('event %# → %s', (ev, expected) => {
    expect(shouldRefetchDetail(ev, M)).toBe(expected);
  });
});

describe('PatientDetail module', () => {
  it('resolves its imports (Timeline.tsx vs timeline.ts) and exports the page component', async () => {
    const mod = await import('./PatientDetail');
    expect(typeof mod.default).toBe('function');
    expect(mod.DETAIL_REFETCH_DEBOUNCE_MS).toBe(300);
  }, 60_000); // first import transforms Recharts, which is slow under a full parallel run
});

describe('Timeline view', () => {
  it('renders an ordered list with a visible "Loop closed" badge for a done task linked to an alert', () => {
    const entries = buildTimeline(
      [visit({ id: 'v1', visit_date: '2025-03-01', hb_gdl: 6.8 })],
      [alert()],
      [task()],
      '2025-03-05',
    );
    const html = renderToStaticMarkup(createElement(Timeline, { entries }));
    expect(html).toContain('<ol');
    expect(html.match(/<li/g)?.length).toBe(entries.length);
    expect(html).toContain('Loop closed');
    expect(html.indexOf('Visit recorded')).toBeLessThan(html.indexOf('Loop closed'));
  });

  it('shows no badge for a done task without an alert, and an empty state for no entries', () => {
    const entries = buildTimeline([], [], [task({ alert_id: null })], '2025-03-05');
    expect(renderToStaticMarkup(createElement(Timeline, { entries }))).not.toContain('Loop closed');
    expect(renderToStaticMarkup(createElement(Timeline, { entries: [] }))).toContain('No events yet.');
  });

  it('formats instants in IST and date-only kinds without a time', () => {
    const at = Date.parse('2025-03-01T06:10:00Z');
    expect(formatTimelineTime({ at, kind: 'alert_acknowledged' })).toBe('2025-03-01 11:40 IST');
    expect(formatTimelineTime({ at, kind: 'visit' })).toBe('2025-03-01');
    expect(formatTimelineTime({ at: Number.NaN, kind: 'visit' })).toBe('Unknown time');
  });
});
