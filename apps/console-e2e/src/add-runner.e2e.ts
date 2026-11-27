import type { Page } from '@playwright/test';
import { OWNER_ACCOUNT_ID, isEnrolmentIntentId, type EnrolmentIntentDto } from '@shared/contracts';
import { INTENTS, bindAsRunner, commandFor, withApi } from './support/add-runner';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimStatus } from './support/runner';
import { E2E_RUNNER_IMAGE_DIGEST } from './stack/local-stack';
import { seed } from './support/stack';

/**
 * Settings › Runners › «Подключить раннер» (#634 PR 4) end to end: the wizard shows the API's `setup` command (the
 * local stack has no https origin, so the release one-liner is off and the runbook path shows), a runner binds its key
 * with the runner's own `POST /runner/enrol/start` (no browser), the owner compares the fingerprint and approves, and
 * the runner comes online. Plus the expired, withdrawn-elsewhere and fingerprint-reject paths, the mis-click guard,
 * a 409 "changed" on approve and the D3 line while the owner count is unknown (#878).
 */

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

/**
 * #878: a click that was aimed at «Отозвать запрос» and lands the moment the poll swaps in «Подтвердить». Clicks the
 * approve button as soon as it exists, from inside the page, so no Playwright wait can make it late.
 */
async function armMisClick(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const approve = document.querySelector<HTMLButtonElement>('[data-testid="wizard-approve"]');
      if (approve !== null) {
        observer.disconnect();
        approve.click();
        document.body.dataset['e2eMisClick'] = 'done';
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

test('add a Mac runner: the command, the fingerprint compared and approved, then on line', async ({
  page,
  stack,
}) => {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  const { dialog, intentId } = await commandFor(page, 'E2E Wizard Mac');
  await expect(dialog.getByTestId('wizard-step')).toHaveText(
    ru('runners.wizard.step', { n: 2, name: ru('runners.wizard.steps.command') }),
  );
  // S2: no release one-liner on this stack, so the runbook path with the API's `setup` line.
  await expect(dialog.getByTestId('wizard-runbook')).toBeVisible();
  await expect(dialog.getByTestId('wizard-waiting')).toContainText(ru('runners.wizard.waiting'));
  await expectAccessible(page, 'Add runner wizard, command');

  await armMisClick(page);
  const bound = await bindAsRunner(stack, intentId);
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.confirm.title') })).toBeFocused();
  // #878: the click that landed on the freshly swapped-in button approved nothing.
  await expect(page.locator('body')).toHaveAttribute('data-e2e-mis-click', 'done');
  const afterMisClick = await withApi(
    stack,
    async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state,
  );
  expect(afterMisClick).toBe('bound');
  await expect(dialog.getByTestId('wizard-fingerprint')).toHaveText(bound.fingerprint);
  await expect(dialog.getByTestId('wizard-hostname')).toHaveText('e2e-wizard.local');
  // Decision 6: Enter on the step does not approve.
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('wizard-fingerprint')).toBeVisible();
  await expectAccessible(page, 'Add runner wizard, confirmation');

  await expect(dialog.getByTestId('wizard-approve')).not.toHaveAttribute('aria-disabled', 'true');
  await dialog.getByTestId('wizard-approve').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.approved.title') })).toBeFocused();
  const intent = await withApi(
    stack,
    async (api) => (await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto,
  );
  expect(intent.state).toBe('approved');
  expect(intent.fingerprint).toBe(bound.fingerprint);

  // The runner's first authenticated call is its first signal.
  await withApi(stack, async (api) => {
    expect(await claimStatus(api, { id: intent.runnerId ?? '', key: bound.key })).toBeLessThan(300);
  });
  await expect(dialog.getByTestId('wizard-online')).toContainText('E2E Wizard Mac', { timeout: 15_000 });
  await expectAccessible(page, 'Add runner wizard, on line');
  await dialog.getByTestId('wizard-done').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('runner-card').filter({ hasText: 'E2E Wizard Mac' })).toBeVisible();

  // R-INT-2: the id rode in the path of the owner's own calls only, never in a query or the page's URL.
  expect(urls.filter((url) => url.includes(intentId)).every((url) => new URL(url).search === '')).toBe(true);
  expect(page.url()).not.toContain(intentId);
});

test('add a Linux runner: the API’s two commands by image digest, no docker.sock, approved, then on line (#634 PR 7)', async ({
  page,
  stack,
}) => {
  await page.goto('/settings/runners');
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  await dialog.getByTestId('wizard-name').fill('E2E Linux');
  await dialog.getByTestId('wizard-platform-linux').check();
  await expect(dialog.getByTestId('wizard-platform-linux')).toHaveAccessibleDescription(
    new RegExp(ru('runners.wizard.platform.linuxHint').replaceAll('.', '\\.')),
  );
  await dialog.getByTestId('wizard-submit').click();
  await expect(
    dialog.getByRole('heading', { name: ru('runners.wizard.command.linux.title', { name: 'E2E Linux' }) }),
  ).toBeFocused();

  const image = `ghcr.io/geeera/team-console-runner:0.3.0@${E2E_RUNNER_IMAGE_DIGEST}`;
  const prepare =
    (await dialog.getByTestId('wizard-linux-prepare').getByTestId('copy-code-text').textContent()) ?? '';
  const enrol =
    (await dialog.getByTestId('wizard-command').getByTestId('copy-code-text').textContent()) ?? '';
  const intentId = /-e TC_ENROLMENT=(\S+) /.exec(enrol)?.[1] ?? '';
  expect(isEnrolmentIntentId(intentId), enrol).toBe(true);
  // R-LNX: by digest only, the local stack's own origin, nothing but the request id passed in, and no docker.sock.
  expect(enrol).toContain(`${image} setup --url ${new URL(stack.baseURL).origin} --image ${image}`);
  expect([...enrol.matchAll(/-e (\S+?)=/g)].map((match) => match[1])).toEqual([
    'HOME',
    'TC_RUNNER_HOME',
    'TC_ENROLMENT',
  ]);
  expect(`${prepare}\n${enrol}`).not.toMatch(/docker\.sock|tce_|sk-ant/);
  for (const line of ['User=tcrunner', 'ProtectSystem=strict', 'ProtectHome=yes']) {
    expect(prepare.split('\n').filter((unitLine) => unitLine === line)).toHaveLength(2);
  }
  // The runner's own unit; rootless podman's unit needs its setuid newuidmap and is capability-bounded instead.
  expect(prepare.split('\n').filter((unitLine) => unitLine === 'NoNewPrivileges=yes')).toHaveLength(1);
  expect(prepare).toContain(`${image} run --loop`);
  await expect(dialog.getByTestId('wizard-linux-socket')).toContainText(
    '/var/lib/team-console-runner/podman.sock',
  );
  await expect(
    dialog.getByRole('region', { name: ru('runners.wizard.command.linux.prepareRegion') }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: ru('runners.wizard.command.linux.enrolCopyAria') }),
  ).toBeVisible();
  await expectAccessible(page, 'Add runner wizard, Linux command');

  const bound = await bindAsRunner(stack, intentId, 'linux');
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.confirm.title') })).toBeFocused();
  await expect(dialog.getByTestId('wizard-fingerprint')).toHaveText(bound.fingerprint);
  await expect(dialog.getByTestId('wizard-hostname')).toHaveText('e2e-build-box');
  await expect(dialog.getByTestId('wizard-approve')).not.toHaveAttribute('aria-disabled', 'true');
  await dialog.getByTestId('wizard-approve').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.approved.title') })).toBeFocused();
  await expect(dialog).toContainText(ru('runners.wizard.approved.bodyLinux'));
  const intent = await withApi(
    stack,
    async (api) => (await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto,
  );
  expect(intent).toMatchObject({ state: 'approved', isolation: 'container' });

  await withApi(stack, async (api) => {
    expect(await claimStatus(api, { id: intent.runnerId ?? '', key: bound.key })).toBeLessThan(300);
  });
  await expect(dialog.getByTestId('wizard-online')).toContainText('E2E Linux', { timeout: 15_000 });
  await expectAccessible(page, 'Add runner wizard, Linux runner on line');
});

test('reject a machine whose code does not match, then get a new command', async ({ page, stack }) => {
  const { dialog, intentId } = await commandFor(page, 'E2E Reject');
  await bindAsRunner(stack, intentId);
  await expect(dialog.getByTestId('wizard-fingerprint')).toBeVisible();
  await dialog.getByTestId('wizard-reject').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.rejected.title') })).toBeFocused();
  const state = await withApi(
    stack,
    async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state,
  );
  expect(state).toBe('withdrawn');
  await expectAccessible(page, 'Add runner wizard, rejected');

  await dialog.getByTestId('wizard-again').click();
  await expect(
    dialog.getByRole('heading', { name: ru('runners.wizard.command.title', { name: 'E2E Reject' }) }),
  ).toBeFocused();
  const command =
    (await dialog.getByTestId('wizard-command').getByTestId('copy-code-text').textContent()) ?? '';
  expect(command).not.toContain(intentId);
});

test('a request withdrawn in another tab ends the wizard with a new command offered', async ({
  page,
  stack,
}) => {
  const { dialog, intentId } = await commandFor(page, 'E2E Withdrawn');
  await withApi(stack, async (api) => {
    const response = await api.post(`${INTENTS}/${intentId}/withdraw`, { data: {} });
    expect(response.status(), await response.text()).toBe(204);
  });
  await expect(dialog.getByTestId('wizard-withdrawn')).toContainText(ru('runners.wizard.withdrawn.title'));
  await expect(dialog.getByTestId('wizard-again')).toBeVisible();
});

test('an expired request says so and closes without asking', async ({ page }) => {
  // The ten minutes are the server's: its answer is aged here rather than waited for.
  await page.route(`**${INTENTS}/*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as EnrolmentIntentDto;
    await route.fulfill({ response, json: { ...body, state: 'expired' } });
  });
  const { dialog } = await commandFor(page, 'E2E Expired');
  await expect(dialog.getByTestId('wizard-expired')).toContainText(ru('runners.wizard.expired.title'));
  await expectAccessible(page, 'Add runner wizard, expired');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('closing while the request is live asks first and withdraws it', async ({ page, stack }) => {
  const { dialog, intentId } = await commandFor(page, 'E2E Close');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: ru('runners.wizard.closeConfirm.title') });
  await confirm.getByRole('button', { name: ru('runners.wizard.closeConfirm.confirm') }).click();
  await expect(dialog).toHaveCount(0);
  const state = await withApi(
    stack,
    async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state,
  );
  expect(state).toBe('withdrawn');
});

test('a 409 "changed" on approve shows the server’s code again and never approves on its own', async ({
  page,
  stack,
}) => {
  // The first bound read the page sees carries a code the key does not have, so the API's compare-and-set refuses it.
  let tamper = true;
  let approvals = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/approve')) {
      approvals += 1;
    }
  });
  await page.route(`**${INTENTS}/*`, async (route) => {
    if (route.request().method() !== 'GET' || !tamper) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as EnrolmentIntentDto;
    if (body.state !== 'bound' || body.fingerprint === null) {
      await route.fulfill({ response, json: body });
      return;
    }
    tamper = false;
    await route.fulfill({
      response,
      json: { ...body, fingerprint: body.fingerprint.split('-').reverse().join('-') },
    });
  });
  const { dialog, intentId } = await commandFor(page, 'E2E Changed');
  const bound = await bindAsRunner(stack, intentId);
  const approve = dialog.getByTestId('wizard-approve');
  await expect(dialog.getByTestId('wizard-fingerprint')).not.toHaveText(bound.fingerprint);
  await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
  await approve.click();

  await expect(dialog.getByTestId('wizard-error')).toContainText(ru('runners.wizard.err.changed'));
  await expect(dialog.getByTestId('wizard-fingerprint')).toHaveText(bound.fingerprint);
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.confirm.title') })).toBeFocused();
  expect(approvals).toBe(1);
  const state = await withApi(
    stack,
    async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state,
  );
  expect(state).toBe('bound');
  await expectAccessible(page, 'Add runner wizard, changed on approve');

  await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
  await approve.click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.approved.title') })).toBeFocused();
  expect(approvals).toBe(2);
});

test('the D3 line keeps its conditional wording while the owner count is unknown', async ({ page }) => {
  await page.route(`**/api/v1/accounts/${OWNER_ACCOUNT_ID}/members`, (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto('/settings/runners');
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  const owners = dialog.getByTestId('runner-scope-owners');
  await expect(owners).toHaveText(ru('runners.scope.allOwnersUnknown'));
  await expect(owners).not.toContainText(ru('runners.scope.allOwners'));
  await expect(dialog.getByTestId('runner-scope-all')).toHaveAttribute('aria-describedby', /-all-owners/);
});

test('a 429 while polling says the console asked to slow down and waits out Retry-After (#879)', async ({
  page,
}) => {
  // The real limit is 120 reads a minute (#880); one refused read is enough to see the wizard honour it.
  let refusals = 0;
  let readsAfter = 0;
  await page.route(`**${INTENTS}/*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    if (refusals === 0) {
      refusals += 1;
      await route.fulfill({
        status: 429,
        headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '5' },
        json: {
          type: 'https://team-console.dev/problems/rate-limited',
          title: 'Too Many Requests',
          status: 429,
        },
      });
      return;
    }
    readsAfter += 1;
    await route.fallback();
  });
  const { dialog } = await commandFor(page, 'E2E Limited');
  const banner = dialog.getByTestId('wizard-poll-limited');
  await expect(banner).toHaveText(ru('runners.wizard.pollRateLimited', { seconds: 5 }));
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(dialog.getByTestId('wizard-poll-failing')).toHaveCount(0);
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  expect(readsAfter).toBeGreaterThan(0);
});
