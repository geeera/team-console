import { generateKeyPairSync } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { OWNER_ACCOUNT_ID, type RunnerPolicyDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, type Stack } from './support/stack';

/**
 * Settings › Runners (#464, ADR 0008 row 2-E part A) end to end: the owner opens it from Settings, gets a one-time
 * enrolment code with the exact `enrol` command, a runner enrols with it (the runner's own `POST /runner/enrol`,
 * no browser), the list shows it (backend, version below the stack's minimum 0.2.0, host, projects), the owner pins
 * the account's placement to it, narrows its projects and revokes it.
 */

const COMMAND = /^team-console-runner enrol --url (http:\/\/127\.0\.0\.1:\d+) --code (tce_[A-Za-z0-9_-]{43})$/;

/** The runner binary's half of enrolment: a fresh Ed25519 key, its public JWK only. */
async function enrolAsRunner(api: APIRequestContext, code: string): Promise<string> {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const response = await api.post('/api/v1/runner/enrol', {
    data: {
      code,
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-mac.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'user',
      version: '0.1.0',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { runnerId: string }).runnerId;
}

/** Enrols with the code, then proves it was single use: a second enrolment with it is refused. */
async function enrolOnceWith(stack: Stack, code: string): Promise<string> {
  const api = await apiClient(stack);
  try {
    const runnerId = await enrolAsRunner(api, code);
    const again = await api.post('/api/v1/runner/enrol', { data: { code } });
    expect(again.status()).toBeGreaterThanOrEqual(400);
    return runnerId;
  } finally {
    await api.dispose();
  }
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('enrol a runner with a one-time code, see it listed, pin placement to it, narrow it and revoke it', async ({
  page,
  stack,
}) => {
  await page.goto('/settings');
  await page.getByTestId('runners-entry').getByRole('link').click();
  await expect(page).toHaveURL(/\/settings\/runners$/);
  await expect(page.getByRole('heading', { level: 1, name: ru('runners.title') })).toBeFocused();
  await expect(page.getByTestId('runners-empty')).toContainText(ru('runners.empty.title'));
  await expectAccessible(page, 'Settings › Runners (empty)');

  // 1. The one-time code and the command to paste.
  await page.getByTestId('runners-empty').getByTestId('runners-enrol').click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  await expect(dialog.getByTestId('enrol-name')).toBeFocused();
  await dialog.getByTestId('enrol-name').fill('E2E Mac');
  await dialog.locator('[data-slug="team-console"] input').check();
  await expectAccessible(page, 'New runner dialog');
  await dialog.getByTestId('enrol-submit').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.enrol.onceTitle') })).toBeFocused();
  const command = (await dialog.getByTestId('copy-code-text').textContent()) ?? '';
  const [, url, code = ''] = COMMAND.exec(command) ?? [];
  expect(url, command).toBe(new URL(stack.baseURL).origin);
  await expect(dialog.getByTestId('enrol-expiry')).toContainText('10');
  await expectAccessible(page, 'New runner dialog, code shown once');
  await dialog.getByTestId('enrol-done').click();
  await expect(dialog).toHaveCount(0);

  // 2. The runner enrols with that code (once: a second use is refused), and Refresh lists it.
  const runnerId = await enrolOnceWith(stack, code);
  await page.getByTestId('runners-refresh').click();
  const card = page.getByTestId('runner-card').filter({ hasText: 'E2E Mac' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(ru('runners.backend.user'));
  await expect(card.getByTestId('runner-version')).toHaveText('0.1.0');
  await expect(card.getByTestId('runner-behind')).toHaveText(ru('runners.card.behind'));
  await expect(card).toContainText('e2e-mac.local · darwin/arm64');
  await expect(card.getByTestId('runner-projects')).toHaveText('team-console');
  await expect(page.getByTestId('runners-release')).toContainText('0.3.0');
  await expectAccessible(page, 'Settings › Runners (one runner)');

  // 3. Placement: the account default pinned to this runner, applied at the next claim.
  const account = page.getByTestId('runners-policy-account');
  await account.getByTestId('policy-mode-pinned').check();
  await account.getByTestId('policy-pinned').selectOption(runnerId);
  await account.getByTestId('runner-policy-save').click();
  await expect(account.getByTestId('runner-policy-saved')).toHaveText(ru('runners.policy.saved'));
  await expect(account.getByTestId('runner-policy-effective')).toHaveText(
    ru('runners.policy.effective', { summary: ru('runners.policy.summary.pinned', { runner: 'E2E Mac' }) }),
  );
  const check = await apiClient(stack);
  try {
    const stored = await check.get(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runner-policy`);
    expect(((await stored.json()) as RunnerPolicyDto).policy).toEqual({ mode: 'pinned', runner: runnerId });
  } finally {
    await check.dispose();
  }
  // The project follows the account default until it gets its own.
  await expect(page.getByTestId('runners-policy-project').getByTestId('runner-policy-effective')).toContainText(
    'E2E Mac',
  );

  // 4. Narrow its projects: the dialog warns that its jobs there would be cancelled.
  await card.getByTestId('runner-edit-projects').click();
  const projects = page.getByRole('dialog', { name: ru('runners.projects.title') });
  await projects.locator('[data-slug="team-console"] input').uncheck();
  await expect(projects.getByTestId('runner-projects-narrowing')).toBeVisible();
  await projects.getByTestId('runner-projects-save').click();
  await expect(projects).toHaveCount(0);
  await expect(card.getByTestId('runner-projects')).toHaveText(ru('runners.card.noProjects'));

  // 5. Revoke, after a danger confirmation.
  await card.getByTestId('runner-revoke').click();
  const confirm = page.getByRole('alertdialog', { name: ru('runners.revoke.title', { name: 'E2E Mac' }) });
  await expect(confirm).toContainText(ru('runners.revoke.itemJobs'));
  await expectAccessible(page, 'Revoke runner confirmation');
  await confirm.getByRole('button', { name: ru('runners.revoke.confirm') }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card.getByTestId('runner-presence')).toHaveText(ru('runners.presence.revoked'));
  await expect(card.getByTestId('runner-revoke')).toHaveCount(0);
  await expectAccessible(page, 'Settings › Runners (revoked)');
});
