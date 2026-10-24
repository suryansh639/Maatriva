/**
 * Mock SMS log panel and AMBER digest page views (Requirements 17.4, 25.3, 25.4).
 *
 * DoctorLayout's route wiring is not imported here: Leaflet (via VillageMap) needs
 * `window` at import time. `npm run build` and the browser smoke test cover it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DigestOut, NotificationOut } from '../shared/types';
import { DigestView, digestSentMessage, SEND_DIGEST_LABEL } from './DigestPage';
import {
  shouldRefetchSmsLog,
  SMS_LOG_LABEL,
  SMS_LOG_LIMIT,
  SmsLogView,
  smsRecipientLabel,
} from './SmsLogPanel';

const DEMO = '00000000-0000-4000-8000-000000000001';

function sms(over: Partial<NotificationOut> = {}): NotificationOut {
  return {
    id: 'n1',
    channel: 'sms',
    kind: 'red_alert',
    status: 'mock_sent',
    to_user_id: 'u1',
    to_username: 'doctor1',
    to_role: 'doctor',
    to_phone: '9000000001',
    body: 'MAATRIVA RED: 000000 Dankaur - Hb 6.8 g/dL (<7.0). Open dashboard.',
    related_alert_id: 'a1',
    related_task_id: null,
    created_at: '2025-01-15T04:30:00Z',
    ...over,
  };
}

describe('SmsLogPanel', () => {
  it('asks for the latest 50 rows and is labelled as not sent', () => {
    expect(SMS_LOG_LIMIT).toBe(50);
    expect(SMS_LOG_LABEL).toBe('Mock SMS – not sent');
  });

  it('refetches only on events that write SMS rows', () => {
    expect(shouldRefetchSmsLog({ type: 'alert.created' })).toBe(true);
    expect(shouldRefetchSmsLog({ type: 'alert.updated' })).toBe(true);
    expect(shouldRefetchSmsLog({ type: 'task.done' })).toBe(true);
    expect(shouldRefetchSmsLog({ type: 'risk.changed' })).toBe(false);
    expect(shouldRefetchSmsLog({ type: 'hello' })).toBe(false);
  });

  it('labels the recipient by username and role, with fallbacks', () => {
    expect(smsRecipientLabel({ to_username: 'asha1', to_role: 'asha' })).toBe('asha1 (ASHA)');
    expect(smsRecipientLabel({ to_username: null, to_role: 'anm' })).toBe('ANM');
    expect(smsRecipientLabel({ to_username: null, to_role: null })).toBe('Unknown recipient');
  });

  it('renders kind, recipient, body, IST time and mock_sent status in the given order', () => {
    const html = renderToStaticMarkup(
      createElement(SmsLogView, {
        rows: [
          sms(),
          sms({ id: 'n2', kind: 'task_assigned', to_username: 'asha1', to_role: 'asha', body: 'Task body' }),
        ],
      }),
    );
    expect(html).toContain('<caption>Mock SMS – not sent');
    expect(html).toContain('RED alert');
    expect(html).toContain('doctor1 (Doctor)');
    expect(html).toContain('MAATRIVA RED: 000000 Dankaur');
    expect(html).toContain('2025-01-15 10:00 IST');
    expect(html).toContain('mock_sent');
    expect(html.indexOf('MAATRIVA RED')).toBeLessThan(html.indexOf('Task body'));
    expect(html).toContain('Task assigned');
  });

  it('shows an empty state with no rows', () => {
    expect(renderToStaticMarkup(createElement(SmsLogView, { rows: [] }))).toContain('No mock SMS yet.');
  });
});

describe('DigestPage', () => {
  const digest: DigestOut = {
    as_of: '2025-01-15T04:30:00Z',
    since: '2025-01-08T04:30:00Z',
    total: 2,
    villages: [
      {
        village_id: 'v1',
        village_name: 'Dadri',
        count: 1,
        items: [
          {
            alert_id: 'a1',
            mother_id: DEMO,
            mother_name: 'Asha Devi (synthetic)',
            short_code: '000000',
            risk_level: 'AMBER',
            flag_codes: ['HB_MODERATE'],
            reasons: ['Hb 8.9 g/dL (7.0–9.9)'],
            summary: 'Hb 8.9 g/dL (7.0–9.9)',
            created_at: '2025-01-14T04:30:00Z',
            updated_at: '2025-01-14T04:30:00Z',
          },
        ],
      },
      {
        village_id: 'v2',
        village_name: 'Jewar',
        count: 1,
        items: [
          {
            alert_id: 'a2',
            mother_id: 'abcdef00-0000-4000-8000-000000000002',
            mother_name: 'Rekha (synthetic)',
            short_code: 'ABCDEF',
            risk_level: 'AMBER',
            flag_codes: ['LATE_REG'],
            reasons: ['Registered at 13w 2d (>12w)'],
            summary: 'Registered late',
            created_at: '2025-01-13T04:30:00Z',
            updated_at: '2025-01-13T04:30:00Z',
          },
        ],
      },
    ],
  };

  const render = (d: DigestOut) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DigestView, { digest: d })));

  it('groups items by village with short code, name, reasons, risk chip and a patient link', () => {
    const html = render(digest);
    expect(html).toContain('Dadri');
    expect(html).toContain('Jewar');
    expect(html.indexOf('Dadri')).toBeLessThan(html.indexOf('Jewar'));
    expect(html).toContain('000000');
    expect(html).toContain('Asha Devi (synthetic)');
    expect(html).toContain('Hb 8.9 g/dL (7.0–9.9)');
    expect(html).toContain('data-risk="AMBER"');
    expect(html).toContain(`href="/doctor/mother/${DEMO}"`);
    expect(html).toContain('2 open AMBER alerts');
  });

  it('shows an empty state when there are no AMBER alerts', () => {
    expect(render({ ...digest, total: 0, villages: [] })).toContain('No open AMBER alerts in the last 7 days.');
  });

  it('labels the send button and reports the rows written', () => {
    expect(SEND_DIGEST_LABEL).toBe('Send digest SMS (mock)');
    expect(digestSentMessage(1)).toContain('1 mock SMS row ');
    expect(digestSentMessage(3)).toContain('3 mock SMS rows');
    expect(digestSentMessage(0)).toContain('no mock SMS was written');
  });
});
