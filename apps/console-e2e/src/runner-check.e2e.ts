import type { Locator, Page, Request, Route } from '@playwright/test';
import { problemTypeOf, type EnrolmentIntentDto, type RunnerCheckDto } from '@shared/contracts';
import { INTENTS, bindAsRunner, commandFor, withApi } from './support/add-runner';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimCheck, claimStatus, finishCheck, type E2eRunner } from './support/runner';
import { seed, type Stack } from './support/stack';

/**
 * The runner check on step 4b of the add-runner wizard (#1059 PR 3, UX §12) end to end. The happy paths run against
 * the stack's real API with a runner played over its HTTP API (the declaration in the claim, the check handed out,
 * its `finish`): the automatic start, N8's silent retry, a failure fixed and checked again, the 4-minute give-up and
 * the re-attach, «Готово» mid-check, the below-minimum runner. What the stack cannot produce on demand is stubbed on
 * the browser's side only: a hostile or unknown answer, `not-picked-up` (150 s on the server), a 429 and a 403.
 */

const CHECKS_PATH = /\/api\/v1\/accounts\/[^/]+\/runners\/[^/]+\/checks$/;
const CHECK_PATH = /\/api\/v1\/accounts\/[^/]+\/runners\/[^/]+\/checks\/[^/]+$/;

const isStart = (request: Request): boolean => request.method() === 'POST' && CHECKS_PATH.test(request.url());
const isRead = (request: Request): boolean => request.method() === 'GET' && CHECK_PATH.test(request.url());

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

interface OnLine {
  readonly dialog: Locator;
  readonly panel: Locator;
  readonly runner: E2eRunner;
}

/**
 * The wizard up to «Раннер на связи»: the command, the runner's bind, the owner's approval, the runner's first claim.
 * `declare` is whether that claim declares the check (a release with #1068 always does).
 */
async function onLine(
  page: Page,
  stack: Stack,
  name: string,
  { declare = true, version = '0.3.0' }: { declare?: boolean; version?: string } = {},
): Promise<OnLine> {
  const { dialog, intentId } = await commandFor(page, name);
  const bound = await bindAsRunner(stack, intentId, 'mac', version);
  const approve = dialog.getByTestId('wizard-approve');
  await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
  await approve.click();
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.approved.title') })).toBeFocused();
  const intent = await withApi(
    stack,
    async (api) => (await (await api.get(`${INTENTS}/${intentId}`)).json()) as EnrolmentIntentDto,
  );
  const runner = { id: intent.runnerId ?? '', key: bound.key };
  await withApi(stack, async (api) => {
    if (declare) {
      expect(await claimCheck(api, runner)).toBeNull();
    } else {
      expect(await claimStatus(api, runner)).toBe(204);
    }
  });
  await expect(dialog.getByTestId('wizard-online')).toContainText(name, { timeout: 15_000 });
  return { dialog, panel: dialog.getByTestId('wizard-check'), runner };
}

function problem(route: Route, status: number, slug: string, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
    json: { type: problemTypeOf(slug), title: 'x', status },
  });
}

/** Answers every read of a check with `body`, built on the check the real API holds. */
async function answerReads(page: Page, body: (check: RunnerCheckDto) => unknown): Promise<void> {
  await page.route(CHECK_PATH, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, json: body((await response.json()) as RunnerCheckDto) });
  });
}

test('a runner on line is checked by itself and passes: the real API, a real claim and finish', async ({
  page,
  stack,
}) => {
  const started = page.waitForRequest(isStart);
  const { dialog, panel, runner } = await onLine(page, stack, 'E2E Check Pass');
  const post = await started;
  // Review item 4 / security test 3: the API's CSRF rule is a same-origin JSON write, and the API accepted it.
  const headers = await post.allHeaders();
  expect(headers['content-type']).toContain('application/json');
  expect(headers['sec-fetch-site']).toBe('same-origin');
  expect(post.postDataJSON()).toEqual({ kind: 'smoke' });
  const answer = await post.response();
  expect(answer?.status()).toBe(201);
  const created = (await answer?.json()) as RunnerCheckDto;

  await expect(panel).toHaveAttribute('data-state', 'queued');
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByTestId('wizard-check-start')).toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'Runner check, waiting for pickup');

  const handed = await withApi(stack, (api) => claimCheck(api, runner));
  expect(handed?.id).toBe(created.id);
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(panel).toContainText(ru('runners.wizard.check.running'));
  await withApi(stack, (api) =>
    finishCheck(api, runner, created.id, { result: 'passed', claudeVersion: '2.1.4' }),
  );

  await expect(panel).toHaveAttribute('data-state', 'passed');
  await expect(dialog.getByTestId('wizard-check-version')).toHaveText('2.1.4');
  await expect(panel).toContainText(ru('runners.wizard.check.passed.title'));
  await expect(panel).toContainText(ru('runners.wizard.check.passed.note'));
  // Review item 5: a pass proves a credential is there, never that the sign-in works.
  await expect(panel).not.toContainText(/вход проверен|всё работает|готов к заданиям/i);
  await expect(panel).not.toHaveAttribute('aria-busy', 'true');
  // §12.5: a result never moves focus; it stays on the step's heading from the online flip.
  await expect(dialog.getByRole('heading', { name: ru('runners.wizard.online.title') })).toBeFocused();
  await expectAccessible(page, 'Runner check, passed');
});

test('N8: on the automatic start a runner-outdated is retried once, silently, 10 s later', async ({
  page,
  stack,
}) => {
  const answers: number[] = [];
  page.on('response', (response) => {
    if (isStart(response.request())) {
      answers.push(response.status());
    }
  });
  // The first signal comes from a claim that declares nothing, as it would before the declaration is stored.
  const { panel, runner } = await onLine(page, stack, 'E2E Check N8', { declare: false });
  await expect.poll(() => answers).toEqual([409]);
  await expect(panel).toHaveAttribute('data-state', 'starting');
  await withApi(stack, async (api) => expect(await claimCheck(api, runner)).toBeNull());
  await expect(panel).toHaveAttribute('data-state', 'queued', { timeout: 15_000 });
  expect(answers).toEqual([409, 201]);
});

test('a runner whose sign-in is missing gets the Mac fix, and «Проверить снова» checks it again', async ({
  page,
  stack,
}) => {
  const { dialog, panel, runner } = await onLine(page, stack, 'E2E Check Fix');
  await withApi(stack, async (api) => {
    const first = await claimCheck(api, runner);
    expect(first).not.toBeNull();
    await finishCheck(api, runner, first?.id ?? '', { result: 'failed', reason: 'credential-missing' });
  });
  await expect(panel).toHaveAttribute('data-state', 'credential');
  await expect(panel).toContainText(ru('runners.wizard.check.credential.titleMac'));
  // N7: the fix is a setup step on the enrolled Mac, with no --url.
  const fix = dialog.getByRole('region', { name: ru('runners.wizard.check.region.setup') });
  await expect(fix).toHaveText(/setup --only credential,check$/);
  await expect(fix).not.toContainText('--url');
  await expect(panel.locator('.tc-callout--danger')).toHaveCount(0);
  await expectAccessible(page, 'Runner check, sign-in missing');

  const again = dialog.getByTestId('wizard-check-start');
  await expect(again).toHaveText(ru('runners.wizard.check.again'));
  await again.focus();
  await again.click();
  await expect(panel).toHaveAttribute('data-state', 'queued');
  // §12.5: the same button keeps focus through the run.
  await expect(again).toBeFocused();
  await withApi(stack, async (api) => {
    const second = await claimCheck(api, runner);
    expect(second).not.toBeNull();
    await finishCheck(api, runner, second?.id ?? '', { result: 'passed', claudeVersion: '2.1.5' });
  });
  await expect(panel).toHaveAttribute('data-state', 'passed');
  await expect(again).toBeFocused();
});

test('a hostile claudeVersion never becomes markup: no element, no script (review item 2)', async ({
  page,
  stack,
}) => {
  page.on('dialog', (alert) => {
    throw new Error(`a page dialog opened: ${alert.message()}`);
  });
  await answerReads(page, (check) => ({
    ...check,
    state: 'passed',
    claudeVersion: '<img src=x onerror=alert(1)>',
    pickedAt: check.createdAt,
    finishedAt: check.createdAt,
  }));
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Hostile');
  // The read's guard refuses the answer (S5), so it counts as a failed read, never a result.
  await expect(dialog.getByTestId('wizard-poll-failing')).toBeVisible({ timeout: 10_000 });
  await expect(panel).toHaveAttribute('data-state', 'queued');
  await expect(dialog.locator('img')).toHaveCount(0);
  await expect(panel).not.toContainText('onerror');
});

test('an unknown reason falls back to the generic state and the code is never shown (review item 3)', async ({
  page,
  stack,
}) => {
  await answerReads(page, (check) => ({ ...check, state: 'failed', reason: 'brand-new-code' }));
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Unknown');
  await expect(panel).toHaveAttribute('data-state', 'unknown');
  await expect(dialog.getByTestId('wizard-check-title')).toHaveText(ru('runners.wizard.check.host.title'));
  await expect(panel).toContainText(ru('runners.wizard.check.unknown.body'));
  await expect(dialog).not.toContainText('brand-new-code');
  await expectAccessible(page, 'Runner check, unknown reason');
});

test('a check never picked up says the runner may be stopped, asleep or outdated (review item 6)', async ({
  page,
  stack,
}) => {
  // The server's own sweep takes 150 s; its answer is aged here rather than waited for.
  await answerReads(page, (check) => ({ ...check, state: 'failed', reason: 'not-picked-up' }));
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Lost');
  await expect(panel).toHaveAttribute('data-state', 'offline');
  await expect(panel).toContainText(ru('runners.wizard.check.offline.notPickedUp'));
  await expect(dialog.getByRole('region', { name: ru('runners.wizard.slow.region') })).toContainText(
    'self-check',
  );
  await expect(dialog.getByTestId('wizard-check-update')).toBeVisible();
});

test('after 4 minutes the console stops waiting, and «Проверить снова» re-attaches to the same check', async ({
  page,
  stack,
}) => {
  await page.clock.install();
  const ids: string[] = [];
  page.on('response', async (response) => {
    if (isStart(response.request()) && response.ok()) {
      ids.push(((await response.json()) as RunnerCheckDto).id);
    }
  });
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Gave Up');
  await expect(panel).toHaveAttribute('data-state', 'queued');
  await page.clock.fastForward('04:00');
  await expect(panel).toHaveAttribute('data-state', 'gaveUp');
  await expect(panel).toContainText(ru('runners.wizard.check.gaveUp.title'));
  await expectAccessible(page, 'Runner check, gave up');

  // The check is still queued on the server (its 150 s are the server's), so a press re-attaches, never a second one.
  await dialog.getByTestId('wizard-check-start').click();
  await expect(panel).toHaveAttribute('data-state', 'queued');
  await expect.poll(() => ids.length).toBe(2);
  expect(ids[1]).toBe(ids[0]);
});

test('a 429 on the start holds «Проверить снова» until Retry-After and names the time (C9)', async ({
  page,
  stack,
}) => {
  await page.route(CHECKS_PATH, (route) =>
    route.request().method() === 'POST'
      ? problem(route, 429, 'rate-limited', { 'Retry-After': '120' })
      : route.fallback(),
  );
  const reads: string[] = [];
  page.on('request', (request) => {
    if (isRead(request)) {
      reads.push(request.url());
    }
  });
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Limited');
  await expect(panel).toHaveAttribute('data-state', 'rateLimited');
  const title = dialog.getByTestId('wizard-check-title');
  await expect(title).toHaveText(/Слишком много проверок за час\. Проверить снова можно в \d{2}:\d{2}\./);
  const again = dialog.getByTestId('wizard-check-start');
  await expect(again).toHaveAttribute('aria-disabled', 'true');
  await expect(again).toHaveAccessibleDescription(/Проверить снова можно в/);
  expect(reads).toEqual([]);
  await expectAccessible(page, 'Runner check, rate-limited');
});

test('a 403 on the start falls into the banner and leaves no «Проверить» (review item 1)', async ({
  page,
  stack,
}) => {
  await page.route(CHECKS_PATH, (route) =>
    route.request().method() === 'POST' ? problem(route, 403, 'account-owner-only') : route.fallback(),
  );
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Forbidden');
  await expect(dialog.getByTestId('wizard-error')).toHaveText(ru('runners.err.forbidden'));
  await expect(dialog.getByTestId('wizard-error')).toHaveAttribute('role', 'alert');
  await expect(panel).toHaveAttribute('data-state', 'idle');
  await expect(dialog.getByTestId('wizard-check-start')).toHaveCount(0);
});

test('a member gets no wizard and so no «Проверить» (review item 1)', async ({ page }) => {
  await page.route('**/api/v1/accounts', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { accounts: { role: string }[] };
    await route.fulfill({
      response,
      json: { accounts: body.accounts.map((account) => ({ ...account, role: 'member' })) },
    });
  });
  await page.goto('/settings/runners');
  await expect(page.getByTestId('runners-forbidden')).toBeVisible();
  await expect(page.getByTestId('runners-enrol')).toHaveCount(0);
  await expect(page.getByTestId('wizard-check-start')).toHaveCount(0);
});

test('a runner below the minimum version shows C8 and no check is started', async ({ page, stack }) => {
  const starts: string[] = [];
  page.on('request', (request) => {
    if (isStart(request)) {
      starts.push(request.url());
    }
  });
  // The stack's minimum is 0.2.0 (runners.e2e.ts).
  const { dialog, panel } = await onLine(page, stack, 'E2E Check Old', { version: '0.1.0' });
  await expect(dialog.getByTestId('wizard-behind')).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'outdated');
  await expect(panel).toContainText(ru('runners.wizard.check.outdated.title'));
  await expect(dialog.getByTestId('wizard-check-update')).toBeVisible();
  await expect(dialog.getByTestId('wizard-check-start')).toHaveCount(0);
  expect(starts).toEqual([]);
});

test('«Готово» while the check runs closes at once, without a confirm, and the polling stops', async ({
  page,
  stack,
}) => {
  await page.clock.install();
  const reads: string[] = [];
  page.on('request', (request) => {
    if (isRead(request)) {
      reads.push(request.url());
    }
  });
  const { dialog, panel, runner } = await onLine(page, stack, 'E2E Check Close');
  await withApi(stack, async (api) => expect(await claimCheck(api, runner)).not.toBeNull());
  await page.clock.runFor(2_000);
  await expect(panel).toHaveAttribute('data-state', 'running');
  await dialog.getByTestId('wizard-done').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const after = reads.length;
  await page.clock.runFor(30_000);
  expect(reads).toHaveLength(after);
});
