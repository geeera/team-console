import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { OWNER_ACCOUNT_ID, isEnrolmentIntentId, type EnrolmentIntentDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimStatus } from './support/runner';
import { apiClient, seed, type Stack } from './support/stack';

/**
 * Settings › Runners › «Подключить раннер» (#634 PR 4) end to end: the wizard shows the API's `setup` command (the
 * local stack has no https origin, so the release one-liner is off and the runbook path shows), a runner binds its key
 * with the runner's own `POST /runner/enrol/start` (no browser), the owner compares the fingerprint and approves, and
 * the runner comes online. Plus the expired, withdrawn-elsewhere and fingerprint-reject paths, the mis-click guard,
 * a 409 "changed" on approve and the D3 line while the owner count is unknown (#878).
 */

const INTENTS = `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-intents`;

interface Bound {
  readonly fingerprint: string;
  readonly key: KeyObject;
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

/** Opens the wizard from the empty state, names the runner and asks for the command; answers the intent id. */
async function commandFor(page: Page, name: string): Promise<{ dialog: Locator; intentId: string }> {
  await page.goto('/settings/runners');
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  await expect(dialog.getByTestId('wizard-name')).toBeFocused();
  await dialog.getByTestId('wizard-name').fill(name);
  await dialog.getByTestId('wizard-submit').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.command.title', { name }) })).toBeFocused();
  const command = (await dialog.getByTestId('wizard-command').getByTestId('copy-code-text').textContent()) ?? '';
  const intentId = /--enrolment (\S+)$/.exec(command)?.[1] ?? '';
  expect(isEnrolmentIntentId(intentId), command).toBe(true);
  return { dialog, intentId };
}

/** The runner's half of `setup`: a fresh key bound to the intent; the console answers the fingerprint. */
async function bindAsRunner(stack: Stack, intentId: string): Promise<Bound> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const api = await apiClient(stack);
  try {
    const response = await api.post('/api/v1/runner/enrol/start', {
      data: {
        intentId,
        publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x },
        host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-wizard.local' },
        capabilities: { local: true, maxConcurrency: 1 },
        isolation: 'user',
        version: '0.3.0',
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return { fingerprint: ((await response.json()) as { fingerprint: string }).fingerprint, key: privateKey };
  } finally {
    await api.dispose();
  }
}

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

async function withApi<T>(stack: Stack, run: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await apiClient(stack);
  try {
    return await run(api);
  } finally {
    await api.dispose();
  }
}

test('add a Mac runner: the command, the fingerprint compared and approved, then on line', async ({ page, stack }) => {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  const { dialog, intentId } = await commandFor(page, 'E2E Wizard Mac');
  await expect(dialog.getByTestId('wizard-step')).toHaveText(ru('runners.wizard.step', { n: 2, name: ru('runners.wizard.steps.command') }));
  // S2: no release one-liner on this stack, so the runbook path with the API's `setup` line.
  await expect(dialog.getByTestId('wizard-runbook')).toBeVisible();
  await expect(dialog.getByTestId('wizard-waiting')).toContainText(ru('runners.wizard.waiting'));
  await expectAccessible(page, 'Add runner wizard, command');

  await armMisClick(page);
  const bound = await bindAsRunner(stack, intentId);
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.confirm.title') })).toBeFocused();
  // #878: the click that landed on the freshly swapped-in button approved nothing.
  await expect(page.locator('body')).toHaveAttribute('data-e2e-mis-click', 'done');
  const afterMisClick = await withApi(stack, async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state);
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
  const intent = await withApi(stack, async (api) => (await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto);
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

test('reject a machine whose code does not match, then get a new command', async ({ page, stack }) => {
  const { dialog, intentId } = await commandFor(page, 'E2E Reject');
  await bindAsRunner(stack, intentId);
  await expect(dialog.getByTestId('wizard-fingerprint')).toBeVisible();
  await dialog.getByTestId('wizard-reject').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.rejected.title') })).toBeFocused();
  const state = await withApi(stack, async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state);
  expect(state).toBe('withdrawn');
  await expectAccessible(page, 'Add runner wizard, rejected');

  await dialog.getByTestId('wizard-again').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.command.title', { name: 'E2E Reject' }) })).toBeFocused();
  const command = (await dialog.getByTestId('wizard-command').getByTestId('copy-code-text').textContent()) ?? '';
  expect(command).not.toContain(intentId);
});

test('a request withdrawn in another tab ends the wizard with a new command offered', async ({ page, stack }) => {
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
  const state = await withApi(stack, async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state);
  expect(state).toBe('withdrawn');
});

test('a 409 "changed" on approve shows the server’s code again and never approves on its own', async ({ page, stack }) => {
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
    await route.fulfill({ response, json: { ...body, fingerprint: body.fingerprint.split('-').reverse().join('-') } });
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
  const state = await withApi(stack, async (api) => ((await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto).state);
  expect(state).toBe('bound');
  await expectAccessible(page, 'Add runner wizard, changed on approve');

  await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
  await approve.click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.approved.title') })).toBeFocused();
  expect(approvals).toBe(2);
});

test('the D3 line keeps its conditional wording while the owner count is unknown', async ({ page }) => {
  await page.route(`**/api/v1/accounts/${OWNER_ACCOUNT_ID}/members`, (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto('/settings/runners');
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  const owners = dialog.getByTestId('runner-scope-owners');
  await expect(owners).toHaveText(ru('runners.scope.allOwnersUnknown'));
  await expect(owners).not.toContainText(ru('runners.scope.allOwners'));
  await expect(dialog.getByTestId('runner-scope-all')).toHaveAttribute('aria-describedby', /-all-owners/);
});

