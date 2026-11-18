import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { OWNER_ACCOUNT_ID, isRunnerId, type RunnerListDto, type RunnerPolicyDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, type Stack } from './support/stack';
import { localD1 } from './support/tracker-seed';

/** Marks a runner suspect in the worker's local D1, as a sighting from a second address would. */
async function markSuspect(workerIndex: number, runnerId: string): Promise<void> {
  if (!isRunnerId(runnerId)) {
    throw new Error('not a runner id');
  }
  await localD1(
    workerIndex,
    `UPDATE runners SET suspect_at = '2026-11-12T09:00:00.000Z', suspect_reason = 'two-pollers' WHERE id = '${runnerId}'`,
  );
}

/**
 * Settings › Runners (#464, ADR 0008 row 2-E part A) end to end: the owner opens it from Settings, gets a one-time
 * enrolment code with the exact `enrol` command, a runner enrols with it (the runner's own `POST /runner/enrol`,
 * no browser), the list shows it (backend, version below the stack's minimum 0.2.0, host, projects), the owner pins
 * the account's placement to it, narrows its projects and revokes it. #775: the scope — every project of the account
 * or a list — is chosen at enrolment (all by default) and changed on the card without re-enrolling.
 */

// #582: the code rides in the command's environment, never in its argv.
const COMMAND = /^TC_ENROL_CODE=(?<code>tce_[A-Za-z0-9_-]{43}) team-console-runner enrol --url (?<url>http:\/\/127\.0\.0\.1:\d+)$/;

/** The runner binary's half of enrolment: a fresh Ed25519 key (or the given one), its public JWK only. */
function enrolBodyOf(code: string, publicKey: KeyObject = generateKeyPairSync('ed25519').publicKey): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    code,
    publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-mac.local' },
    capabilities: { local: true, maxConcurrency: 1 },
    isolation: 'user',
    version: '0.1.0',
  };
}

async function enrolAsRunner(api: APIRequestContext, code: string): Promise<string> {
  const response = await api.post('/api/v1/runner/enrol', { data: enrolBodyOf(code) });
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
  // #775: all projects of the account is preselected; the list appears for "only the chosen ones".
  await expect(dialog.getByTestId('runner-scope-all')).toBeChecked();
  await expect(dialog.locator('[data-slug="team-console"]')).toHaveCount(0);
  await dialog.getByTestId('runner-scope-selected').check();
  await dialog.locator('[data-slug="team-console"] input').check();
  await expectAccessible(page, 'New runner dialog');
  await dialog.getByTestId('enrol-submit').click();
  await expect(dialog.getByRole('heading', { name: ru('runners.enrol.onceTitle') })).toBeFocused();
  const command = (await dialog.getByTestId('enrol-command').getByTestId('copy-code-text').textContent()) ?? '';
  const { url, code = '' } = COMMAND.exec(command)?.groups ?? {};
  expect(url, command).toBe(new URL(stack.baseURL).origin);
  // #772: the bare code as well, for the `--code -` prompt, copyable on its own.
  const codeOnly = dialog.getByTestId('enrol-code-only');
  await expect(codeOnly.getByTestId('copy-code-text')).toHaveText(code);
  await expect(codeOnly.getByRole('button', { name: ru('runners.enrol.copyCodeAria') })).toBeVisible();
  await expect(dialog.getByText(ru('runners.enrol.codeOnly'))).toBeVisible();
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
  const projects = page.getByRole('dialog', { name: ru('runners.scope.title') });
  await expect(projects.getByTestId('runner-scope-selected')).toBeChecked();
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

/**
 * Gets a code from the dialog as the owner does, and answers it (the command's `TC_ENROL_CODE`). The dialog's default
 * scope is every project of the account (#775); `selected` ticks the one project the stack seeds.
 */
async function issueCodeInDialog(page: Page, name: string, scope: 'all' | 'selected' = 'all'): Promise<string> {
  await page.getByTestId('runners-enrol').first().click();
  const dialog = page.getByRole('dialog', { name: ru('runners.enrol.title') });
  await dialog.getByTestId('enrol-name').fill(name);
  if (scope === 'selected') {
    await dialog.getByTestId('runner-scope-selected').check();
    await dialog.locator('[data-slug="team-console"] input').check();
  }
  await dialog.getByTestId('enrol-submit').click();
  await expect(dialog.getByTestId('enrol-scope')).toContainText(
    scope === 'all' ? ru('runners.enrol.scopeAll') : ru('runners.enrol.projects', { projects: 'team-console' }),
  );
  const command = (await dialog.getByTestId('enrol-command').getByTestId('copy-code-text').textContent()) ?? '';
  const { code = '' } = COMMAND.exec(command)?.groups ?? {};
  await dialog.getByTestId('enrol-done').click();
  await expect(dialog).toHaveCount(0);
  return code;
}

/** A runner JWT as the binary mints one (apps/runner/src/client/runner-jwt.ts): EdDSA, one `jti` per call. */
function runnerJwtOf(privateKey: KeyObject, runnerId: string, audience: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${part({ sub: runnerId, aud: audience, iat, exp: iat + 120, jti: randomUUID() })}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
}

// #571: the runner hits the Claude usage limit, pauses itself and mirrors that on its own door; the owner sees why
// and until when. The pause rules (claim, bounds, accounts) are the API's own specs (runner-pause.spec.ts).
test('a runner paused on its usage limit says so, with the reason and the time it resumes', async ({ page, stack }) => {
  await page.goto('/settings/runners');
  const code = await issueCodeInDialog(page, 'E2E Mac');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const until = new Date(Date.now() + 90 * 60_000).toISOString();
  const api = await apiClient(stack);
  try {
    const enrol = await api.post('/api/v1/runner/enrol', { data: enrolBodyOf(code, publicKey) });
    expect(enrol.status(), await enrol.text()).toBe(201);
    const { runnerId, audience } = (await enrol.json()) as { runnerId: string; audience: string };
    const pause = await api.post('/api/v1/runner/pause', {
      data: { reason: 'usage-limit', until },
      headers: { Authorization: `Bearer ${runnerJwtOf(privateKey, runnerId, audience)}` },
    });
    expect(pause.status(), await pause.text()).toBe(200);
  } finally {
    await api.dispose();
  }

  await page.getByTestId('runners-refresh').click();
  const card = page.getByTestId('runner-card').filter({ hasText: 'E2E Mac' });
  await expect(card.getByTestId('runner-presence')).toHaveText(ru('runners.presence.paused'));
  const note = card.getByTestId('runner-pause');
  await expect(note).toContainText(ru('runners.card.pause.usage-limit'));
  await expect(note.locator('time')).toHaveAttribute('datetime', until);
  await expect(note.locator('time')).toContainText(/\d{2}:\d{2}/);
  await expectAccessible(page, 'Settings › Runners (paused runner)');
});

// #775: the scope is changed on the card without re-enrolling — `selected` → `all` and back — and the stored row
// follows, so the next claim (and the runner, through `/runner/self` and each claim's `scope`) sees it.
test('switch a runner between its chosen projects and all projects of the account without re-enrolling', async ({ page, stack }) => {
  await page.goto('/settings/runners');
  const runnerId = await enrolOnceWith(stack, await issueCodeInDialog(page, 'E2E Mac', 'selected'));
  await page.getByTestId('runners-refresh').click();
  const card = page.getByTestId('runner-card').filter({ hasText: 'E2E Mac' });
  await expect(card.getByTestId('runner-projects')).toHaveText('team-console');
  await expect(card.getByTestId('runner-scope')).toHaveCount(0);

  // To all projects: no narrowing, so no warning; the card says so and lists what is served now.
  await card.getByTestId('runner-edit-projects').click();
  const widen = page.getByRole('dialog', { name: ru('runners.scope.title') });
  await expect(widen.getByTestId('runner-scope-selected')).toBeChecked();
  await widen.getByTestId('runner-scope-all').check();
  await expect(widen.locator('[data-slug="team-console"]')).toHaveCount(0);
  await expect(widen.getByTestId('runner-projects-narrowing')).toHaveCount(0);
  await expectAccessible(page, 'Runner scope dialog (all projects)');
  await widen.getByTestId('runner-projects-save').click();
  await expect(widen).toHaveCount(0);
  await expect(card.getByTestId('runner-scope')).toHaveText(ru('runners.card.scopeAll'));
  await expect(card.getByTestId('runner-projects')).toHaveText(ru('runners.card.scopeAllNow', { projects: 'team-console' }));
  await expectAccessible(page, 'Settings › Runners (all-projects runner)');

  const api = await apiClient(stack);
  try {
    const listed = (await (await api.get(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`)).json()) as RunnerListDto;
    expect(listed.runners.find((runner) => runner.id === runnerId)).toMatchObject({
      projectScope: 'all',
      allowedProjects: [],
      servedProjects: [{ slug: 'team-console', accessSource: 'subscription', fit: true }],
    });
  } finally {
    await api.dispose();
  }

  // Back to a list with nothing ticked: the warning names the project whose jobs would be cancelled.
  await card.getByTestId('runner-edit-projects').click();
  const narrow = page.getByRole('dialog', { name: ru('runners.scope.title') });
  await expect(narrow.getByTestId('runner-scope-all')).toBeChecked();
  await narrow.getByTestId('runner-scope-selected').check();
  await expect(narrow.getByTestId('runner-projects-narrowing')).toContainText('team-console');
  await expectAccessible(page, 'Runner scope dialog (narrowing)');
  await narrow.getByTestId('runner-projects-save').click();
  await expect(narrow).toHaveCount(0);
  await expect(card.getByTestId('runner-scope')).toHaveCount(0);
  await expect(card.getByTestId('runner-projects')).toHaveText(ru('runners.card.noProjects'));
});

// #492: a code shown to the wrong person is withdrawn from the list before its ten minutes are up.
test('withdraw a pending enrolment code, after which it enrols nothing', async ({ page, stack }) => {
  await page.goto('/settings/runners');
  const code = await issueCodeInDialog(page, 'Wrong screen');
  const pending = page.getByTestId('runners-pending');
  const row = pending.getByTestId('runners-pending-code').filter({ hasText: 'Wrong screen' });
  await expect(row).toBeVisible();
  await expect(pending).not.toContainText(code);
  await expectAccessible(page, 'Settings › Runners (a pending code)');

  await row.getByTestId('runners-pending-withdraw').click();
  const confirm = page.getByRole('alertdialog', { name: ru('runners.pending.withdrawTitle', { name: 'Wrong screen' }) });
  await expect(confirm).toContainText(ru('runners.pending.withdrawMessage'));
  await expectAccessible(page, 'Withdraw code confirmation');
  await confirm.getByRole('button', { name: ru('runners.pending.withdrawConfirm') }).click();
  await expect(confirm).toHaveCount(0);
  await expect(pending).toHaveCount(0);

  const api = await apiClient(stack);
  try {
    const enrol = await api.post('/api/v1/runner/enrol', { data: enrolBodyOf(code) });
    expect(enrol.status()).toBe(401);
  } finally {
    await api.dispose();
  }
  await page.getByTestId('runners-refresh').click();
  await expect(page.getByTestId('runners-empty')).toBeVisible();
  await expect(page.getByTestId('runners-pending')).toHaveCount(0);
});

// #492: the owner recognises the calls behind a suspect mark (a second machine, briefly) and clears it.
test('clear a runner’s suspect mark after a confirmation', async ({ page, stack }, testInfo) => {
  await page.goto('/settings/runners');
  const runnerId = await enrolOnceWith(stack, await issueCodeInDialog(page, 'E2E Mac'));
  // The detection rows are the API's own (account-runners.spec.ts); here the mark is set as a sighting would set it.
  await markSuspect(testInfo.workerIndex, runnerId);
  await page.getByTestId('runners-refresh').click();
  const card = page.getByTestId('runner-card').filter({ hasText: 'E2E Mac' });
  await expect(card.getByTestId('runner-presence')).toHaveText(ru('runners.presence.suspect'));
  await expect(card.getByTestId('runner-suspect')).toBeVisible();
  await expectAccessible(page, 'Settings › Runners (suspect runner)');

  await card.getByTestId('runner-clear-suspect').click();
  const confirm = page.getByRole('alertdialog', { name: ru('runners.suspect.title', { name: 'E2E Mac' }) });
  await expect(confirm).toContainText(ru('runners.suspect.itemRevoke'));
  await expectAccessible(page, 'Clear suspect mark confirmation');
  await confirm.getByRole('button', { name: ru('runners.suspect.confirm') }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card.getByTestId('runner-suspect')).toHaveCount(0);
  await expect(card.getByTestId('runner-clear-suspect')).toHaveCount(0);
  await expect(card.getByTestId('runner-presence')).not.toHaveText(ru('runners.presence.suspect'));
  await expectAccessible(page, 'Settings › Runners (mark cleared)');
});

/** A runner row as enrolments wrote it before migration 0036 (#827): no enroller recorded. */
async function insertLegacyRunner(workerIndex: number, runnerId: string): Promise<void> {
  if (!isRunnerId(runnerId)) {
    throw new Error('not a runner id');
  }
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const key = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x });
  if (!/^[\w":{},-]+$/.test(key)) {
    throw new Error('unexpected key text');
  }
  await localD1(
    workerIndex,
    `INSERT INTO runners (id, account_id, name, public_key_jwk, host, capabilities, isolation, allowed_projects, version, enrolled_at, hosted, project_scope, enrolled_by)
     VALUES ('${runnerId}', '${OWNER_ACCOUNT_ID}', 'Old Mac', '${key}', '{"os":"darwin","arch":"arm64","hostname":"old-mac.local"}',
       '{"local":true,"maxConcurrency":1}', 'user', '[]', '0.2.0', '2026-11-01T09:00:00.000Z', 0, 'selected', NULL)`,
  );
}

// #827 (owner decision (a)): a runner enrolled before enrollers were recorded says so, and the account's sole owner
// claims it as theirs behind a confirmation; the card then shows no note and no action.
test('claim a runner from before enrollers were recorded as its enroller', async ({ page, stack }, testInfo) => {
  const runnerId = '01M6YSNJ0000000000000827E1';
  await insertLegacyRunner(testInfo.workerIndex, runnerId);
  await page.goto('/settings/runners');
  const card = page.getByTestId('runner-card').filter({ hasText: 'Old Mac' });
  await expect(card.getByTestId('runner-enroller')).toHaveText(ru('runners.card.enroller.claimable'));
  const claim = card.getByTestId('runner-claim-enroller');
  await expect(claim).toHaveText(ru('runners.enroller.open'));
  await expect(claim).toHaveAccessibleName(ru('runners.enroller.aria', { name: 'Old Mac' }));
  await expectAccessible(page, 'Settings › Runners (runner with no enroller)');

  await claim.click();
  const confirm = page.getByRole('alertdialog', { name: ru('runners.enroller.title', { name: 'Old Mac' }) });
  await expect(confirm).toContainText(ru('runners.enroller.itemOnlyYou'));
  await expect(confirm).toContainText(ru('runners.enroller.itemAudit'));
  await expectAccessible(page, 'Claim runner confirmation');
  await confirm.getByRole('button', { name: ru('runners.enroller.confirm') }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card.getByTestId('runner-enroller')).toHaveCount(0);
  await expect(card.getByTestId('runner-claim-enroller')).toHaveCount(0);
  await expectAccessible(page, 'Settings › Runners (runner claimed)');

  const api = await apiClient(stack);
  try {
    const listed = (await (await api.get(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`)).json()) as RunnerListDto;
    expect(listed.runners.find((runner) => runner.id === runnerId)?.enroller).toBe('recorded');
    const again = await api.post(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runnerId}/claim-enroller`, {
      data: {},
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(again.status()).toBe(409);
  } finally {
    await api.dispose();
  }
});
