/**
 * Closed-loop demo E2E (Req 43.1–43.5; design §20).
 *
 * One serial test in two browser contexts:
 * - Setup: log in as `doctor1` through the API and `POST /api/demo/reset` (so
 *   repeated runs start from the same GREEN demo mother), then open the doctor
 *   dashboard first, so its SSE stream is live before the ASHA syncs.
 * - ASHA (`asha1`, Pixel 7) steps 01–08: record an offline visit with the
 *   simulated scale (56.6 kg) and Hb 6.8, confirm the mother, see "1 pending",
 *   go online and see "Synced".
 * - Doctor steps 09–10: the RED toast arrives live; "Open patient"; issue
 *   "Home visit within 48 hours".
 * - ASHA steps 11–12: sync, find the task, mark it done, sync.
 * - Doctor step 13: the timeline shows "Loop closed".
 *
 * Every step is a `test.step('NN name')`, so a timeout names the failing step
 * (Req 43.5). Screenshots of the 8 key steps go to `docs/screenshots/NN-name.png`.
 * Fresh browser contexts start with empty IndexedDB and the reset rotates the
 * sync epoch, so runs are independent.
 */
import { devices, expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

const DEMO_MOTHER_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_MOTHER = 'Sunita Demo (synthetic)';
const PASSWORD = 'demo1234';
const ACTION_LABEL = 'Home visit within 48 hours';
const TIMEZONE = 'Asia/Kolkata';

/** `<repo>/docs/screenshots/<name>.png`; `rootDir` is the config's testDir (`web/e2e`). */
function shotPath(info: TestInfo, name: string): string {
  return `${info.config.rootDir}/../../docs/screenshots/${name}.png`;
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: shotPath(info, name), fullPage: false });
}

/** Login through the API, then reset the demo mother (Req 43.2). */
async function resetDemo(request: APIRequestContext): Promise<void> {
  const login = await request.post('/api/auth/login', { data: { username: 'doctor1', password: PASSWORD } });
  expect(login.status(), 'doctor1 API login (is the backend seeded?)').toBe(200);
  const { access_token: token } = (await login.json()) as { access_token: string };

  const reset = await request.post('/api/demo/reset', { headers: { Authorization: `Bearer ${token}` } });
  if (reset.status() === 404) {
    throw new Error('backend not in demo mode (MAATRIVA_DEMO=1)');
  }
  expect(reset.status(), 'POST /api/demo/reset').toBe(200);
}

/** Sign in through the login page and wait for the role's area. */
async function signIn(page: Page, username: string, area: '/field' | '/doctor'): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === area || url.pathname.startsWith(`${area}/`));
}

async function newDoctorContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: TIMEZONE, locale: 'en-IN' });
}

async function newAshaContext(browser: Browser): Promise<BrowserContext> {
  // Pixel 7 is a Chromium device descriptor (mobile viewport, touch).
  return browser.newContext({ ...devices['Pixel 7'], timezoneId: TIMEZONE, locale: 'en-IN' });
}

test('closed loop: offline visit, RED alert, doctor action, task done, loop closed', async ({
  browser,
  request,
}, testInfo) => {
  let doctorCtx: BrowserContext | undefined;
  let ashaCtx: BrowserContext | undefined;

  try {
    let doctor!: Page;
    let asha!: Page;
    let taskId = '';

    await test.step('00 setup: reset demo and open the live doctor dashboard', async () => {
      await resetDemo(request);
      doctorCtx = await newDoctorContext(browser);
      doctor = await doctorCtx.newPage();
      await signIn(doctor, 'doctor1', '/doctor');
      await expect(doctor.getByRole('heading', { name: 'Triage queue' })).toBeVisible();
      // The SSE stream must be connected before the ASHA syncs, or the toast is missed.
      await expect(doctor.locator('[data-live-status="live"]')).toBeVisible({ timeout: 20_000 });
    });

    const badge = () => asha.getByTestId('sync-badge');

    await test.step('01 log in as asha1 (phone)', async () => {
      ashaCtx = await newAshaContext(browser);
      asha = await ashaCtx.newPage();
      await signIn(asha, 'asha1', '/field');
      // The first sync (app start) pulls the full snapshot.
      await expect(asha.getByRole('link', { name: DEMO_MOTHER, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(badge()).toContainText('Synced', { timeout: 30_000 });
    });

    await test.step('02 turn on simulate offline', async () => {
      const toggle = asha.getByRole('switch', { name: 'Simulate offline' });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(badge()).toContainText('Offline (simulated)');
    });

    await test.step('03 open the demo mother', async () => {
      await asha.getByRole('link', { name: DEMO_MOTHER, exact: true }).click();
      await expect(asha.getByRole('heading', { level: 1, name: DEMO_MOTHER })).toBeVisible();
      await expect(asha).toHaveURL(new RegExp(DEMO_MOTHER_ID));
    });

    await test.step('04 record a visit: simulated scale 56.6 kg, Hb 6.8', async () => {
      await asha.getByTestId('new-visit').click();
      await expect(asha.getByRole('heading', { level: 1 })).toContainText(DEMO_MOTHER);

      await asha.getByTestId('weight-mode-simulated').click();
      await asha.getByRole('button', { name: 'Demo preset (56.6 kg)' }).click();
      await asha.getByRole('button', { name: 'Step on scale' }).click();
      // "Stabilizing…" for 1 s, then the parsed reading and "Use this reading".
      const useReading = asha.getByRole('button', { name: 'Use this reading' });
      await expect(useReading).toBeEnabled({ timeout: 10_000 });
      await useReading.click();
      await expect(asha.getByTestId('visit-scale-weight')).toContainText('56.60');

      await asha.getByTestId('hb-input').fill('6.8');
      await expect(asha.getByTestId('hb-input')).toHaveValue('6.8');

      const save = asha.getByTestId('visit-save');
      await expect(save).toBeEnabled();
      await shot(asha, testInfo, '04-offline-visit');
      await save.click();
    });

    await test.step('05 confirm the mother', async () => {
      const dialog = asha.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(DEMO_MOTHER);
      await shot(asha, testInfo, '05-confirm-mother');
      await dialog.getByRole('button', { name: `Yes, this is ${DEMO_MOTHER}` }).click();
      await expect(asha.getByTestId('saved-notice')).toBeVisible();
    });

    await test.step('06 badge shows 1 pending', async () => {
      await expect(badge()).toContainText('1 pending');
      await expect(badge()).toContainText('Offline (simulated)');
      await shot(asha, testInfo, '06-one-pending');
    });

    await test.step('07 turn off simulate offline', async () => {
      const toggle = asha.getByRole('switch', { name: 'Simulate offline' });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    await test.step('08 badge shows Synced', async () => {
      await expect(badge()).toContainText('Synced', { timeout: 30_000 });
      await expect(badge()).not.toContainText('pending');
      await shot(asha, testInfo, '08-synced');
    });

    await test.step('09 doctor sees the RED toast', async () => {
      const toast = doctor
        .locator('.toast-region')
        .getByRole('alert')
        .filter({ hasText: 'RED alert' })
        .filter({ hasText: DEMO_MOTHER })
        .first();
      await expect(toast).toBeVisible({ timeout: 20_000 });
      // Hovering pauses the 15 s auto-close while the screenshot is taken.
      await toast.hover();
      await shot(doctor, testInfo, '09-doctor-red-toast');
    });

    await test.step('10 doctor opens the patient and issues HOME_VISIT_48H', async () => {
      const toast = doctor
        .locator('.toast-region')
        .getByRole('alert')
        .filter({ hasText: DEMO_MOTHER })
        .first();
      await toast.getByRole('button', { name: 'Open patient' }).click();
      await expect(doctor).toHaveURL(new RegExp(`/doctor/mother/${DEMO_MOTHER_ID}`));
      await expect(doctor.getByRole('heading', { level: 1, name: DEMO_MOTHER })).toBeVisible();

      const form = doctor.getByTestId('action-form');
      await expect(form).toBeVisible();
      await form.getByTestId('action-type').selectOption('HOME_VISIT_48H');
      await form.getByTestId('issue-action').click();
      await expect(form.getByRole('status')).toContainText(`Action issued: ${ACTION_LABEL} – status open`);
      await shot(doctor, testInfo, '10-action-issued');
    });

    // The demo reset cancels her open tasks, so the only open HOME_VISIT_48H card
    // for her is the one issued in step 10 (done tasks from earlier runs stay done).
    const taskCard = () =>
      asha
        .locator('[data-testid="task-card"][data-action-type="HOME_VISIT_48H"][data-status="open"]')
        .filter({ hasText: DEMO_MOTHER });

    await test.step('11 ASHA sees the task after sync', async () => {
      await asha.getByTestId('nav-tasks').click();
      await expect(asha.getByTestId('tasks-inbox')).toBeVisible();
      await expect(async () => {
        const syncNow = asha.getByTestId('sync-now');
        if (await syncNow.isEnabled()) await syncNow.click();
        await expect(taskCard()).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 45_000 });
      await expect(taskCard()).toContainText(ACTION_LABEL);
      taskId = (await taskCard().getAttribute('data-task-id')) ?? '';
      expect(taskId, 'task id on the card').not.toBe('');
      await taskCard().scrollIntoViewIfNeeded();
      await shot(asha, testInfo, '11-asha-task');
    });

    await test.step('12 ASHA marks the task done and syncs', async () => {
      const card = taskCard();
      await card.getByRole('button', { name: 'Mark done' }).click();
      await card.getByRole('button', { name: 'Save as done' }).click();

      const done = asha.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`);
      await expect(done).toHaveAttribute('data-status', 'done');
      // The pending marker clears once the server confirms the completion in a pull.
      await expect(async () => {
        const syncNow = asha.getByTestId('sync-now');
        if (await syncNow.isEnabled()) await syncNow.click();
        await expect(done.getByTestId('task-pending')).toHaveCount(0, { timeout: 3_000 });
      }).toPass({ timeout: 45_000 });
      await expect(badge()).toContainText('Synced', { timeout: 30_000 });
    });

    await test.step('13 doctor timeline shows Loop closed', async () => {
      // `task.done` over SSE refetches the open patient page (Req 19.9). Match this
      // run's task: earlier runs leave their own "Loop closed" entries behind.
      await expect(doctor.getByRole('heading', { name: 'Timeline' })).toBeVisible();
      const entry = doctor.locator(`li[data-kind="task_done"][data-ref-id="${taskId}"]`);
      const loopClosed = entry.getByTestId('loop-closed');
      await expect(loopClosed).toBeVisible({ timeout: 20_000 });
      await expect(loopClosed).toHaveText(/Loop closed/);
      await expect(entry).toContainText(`Action done: ${ACTION_LABEL}`);
      await loopClosed.scrollIntoViewIfNeeded();
      await shot(doctor, testInfo, '13-loop-closed');
    });
  } finally {
    await ashaCtx?.close();
    await doctorCtx?.close();
  }
});
