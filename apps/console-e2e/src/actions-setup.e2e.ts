import type { Page, Route } from '@playwright/test';
import {
  ACTIONS_SETUP_ITEMS,
  blockingItemsOf,
  problemTypeOf,
  type ActionsSetupDto,
  type ActionsSetupItemDto,
  type ActionsSetupItemId,
} from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { meetsMinTap } from './support/tap-target';
import { seed } from './support/stack';

/**
 * The customer's GitHub Actions setup page (#759 PR 5) end to end. The local stack is served on localhost, not on
 * the `CONSOLE_PUBLIC_ORIGIN` its rendered workflow names, so its real readiness answer is 503
 * `console-origin-misconfigured`; that answer is checked first. Every other state is the route's own answer replayed
 * through `page.route()` (a ready mock repository is #800): the steps and sub-checks, the GitHub links (github.com
 * only), every answer of `POST …/workflow-pr`, the switch and its `actions-not-ready` refusal, a member's 403, and
 * the Runners readiness line.
 */

const SLUG = 'team-console';
const REPO = 'geeera/team-console';
const PAGE = `/settings/projects/${SLUG}/actions`;
const SETUP_API = `**/api/v1/projects/${SLUG}/actions-setup`;
const PR_API = `**/api/v1/projects/${SLUG}/actions-setup/workflow-pr`;
const FILE_API = `**/api/v1/projects/${SLUG}/actions-setup/workflow`;
const DISPATCH_API = `**/api/v1/projects/${SLUG}/dispatch`;
const PR_URL = `https://github.com/${REPO}/pull/42`;
const INSTALLATION_URL = 'https://github.com/settings/installations/4242';

function readiness(
  items: Partial<Record<ActionsSetupItemId, Omit<ActionsSetupItemDto, 'id'>>> = {},
  dispatch: ActionsSetupDto['dispatch'] = 'pull',
): ActionsSetupDto {
  const rows = ACTIONS_SETUP_ITEMS.map((id): ActionsSetupItemDto => ({ id, ...(items[id] ?? { status: 'ok' }) }));
  return { dispatch, accessSource: 'api_key', ready: blockingItemsOf(rows).length === 0, checkedAt: new Date().toISOString(), items: rows };
}

function problem(status: number, slug: string, extensions: Record<string, unknown> = {}) {
  return { status, contentType: 'application/problem+json', json: { type: problemTypeOf(slug), title: 'x', status, ...extensions } };
}

/** The readiness answer the page gets, replaceable between checks. */
async function answerReadiness(page: Page, answer: () => ActionsSetupDto | ReturnType<typeof problem>): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route(SETUP_API, async (route: Route) => {
    calls += 1;
    const value = answer();
    if ('items' in value) {
      await route.fulfill({ json: value });
    } else {
      await route.fulfill(value);
    }
  });
  await page.route(FILE_API, (route) =>
    route.fulfill({ json: { text: 'name: Team Console runner\non:\n  workflow_dispatch:\n', sha256: 'a'.repeat(64), version: '0.42.0' } }),
  );
  return { calls: () => calls };
}

async function openPage(page: Page): Promise<void> {
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { level: 1, name: ru('actions.title') })).toBeFocused();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, [REPO]);
});

test('the local stack says the console cannot check here; the setup row reads «Не включено» without a check', async ({ page }) => {
  const checks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/actions-setup')) {
      checks.push(request.url());
    }
  });
  await page.goto(`/settings/projects/${SLUG}`);
  const row = page.getByTestId('project-actions-entry');
  await expect(row.getByTestId('project-actions-chip')).toHaveText(ru('actions.row.chip.off'));
  expect(checks).toEqual([]);
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await expect(page.getByTestId('actions-error')).toContainText(ru('actions.err.misconfigured'));
  await expect(page.getByTestId('actions-retry')).toHaveCount(0);
  await expectAccessible(page, 'GitHub Actions setup, console misconfigured');
});

test('partial: each step names its fix and links only to github.com; the Copy path and a held switch', async ({ page }, testInfo) => {
  await answerReadiness(page, () =>
    readiness({
      'app-permissions': { status: 'missing', link: INSTALLATION_URL },
      secret: { status: 'unknown' },
      'protection-rules': { status: 'wrong' },
      workflow: { status: 'missing' },
    }),
  );
  await openPage(page);
  const ledger = page.getByTestId('actions-ledger');
  await expect(page.getByTestId('actions-summary')).toContainText('Не хватает 3 шагов');

  // Permissions not accepted: the installation link, and a secret that is never read as ok.
  await expect(ledger.getByTestId('actions-permissions-link')).toHaveAttribute('href', INSTALLATION_URL);
  await expect(ledger.locator('[data-item="secret"]')).toContainText(ru('actions.env.secret.unknown'));
  await expect(ledger.locator('[data-item="protection-rules"]')).toContainText(ru('actions.env.rules.warning'));
  await expect(ledger.getByTestId('workflow-copy-reason')).toHaveText(ru('actions.wf.noPermission'));
  await expect(ledger.getByTestId('workflow-open-pr')).toHaveCount(0);

  // Every exact string has Copy; every link out of the console points at github.com.
  await ledger.getByTestId('actions-env-how-toggle').click();
  for (const value of ['team-console', 'TC_INFERENCE_API_KEY']) {
    await expect(ledger.getByRole('button', { name: ru('actions.copyAria', { value }) })).toBeVisible();
  }
  for (const href of await ledger.locator('a[target="_blank"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')))) {
    expect(href).toMatch(/^https:\/\/github\.com\//);
  }

  // The Copy path: the file, its version and the create link.
  await ledger.getByTestId('workflow-show-file').click();
  await expect(ledger.getByTestId('workflow-file-meta')).toHaveText(ru('actions.file.meta', { version: '0.42.0', sha: 'a'.repeat(12) }));
  await expect(ledger.getByRole('region', { name: ru('actions.file.region') })).toBeVisible();
  await expectAccessible(page, 'GitHub Actions setup, permissions not accepted');

  // Switch blocked: activating it moves focus to the first step that is not done.
  const switchOn = ledger.getByTestId('switch-on');
  await expect(switchOn).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled, never disabled: it stays focusable and says why when activated.
  await switchOn.focus();
  await page.keyboard.press('Enter');
  await expect(ledger.locator('h3[data-step="permissions"]')).toBeFocused();
  if (testInfo.project.name === 'iphone') {
    // The kit's touch targets: 44 px on a phone.
    expect(meetsMinTap((await ledger.getByTestId('actions-why-toggle').boundingBox())?.height)).toBe(true);
  }
});

test('Open PR: the PR opens and is focused; a foreign PR is never called mergeable', async ({ page }) => {
  let current = readiness({ workflow: { status: 'missing' } });
  await answerReadiness(page, () => current);
  await page.route(PR_API, (route) => route.fulfill({ status: 201, json: { number: 42, url: PR_URL, kind: 'setup' } }));
  await openPage(page);
  const step = page.getByTestId('workflow-step');
  await step.getByTestId('workflow-open-pr').click();
  const link = step.getByTestId('workflow-link-pr');
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute('href', PR_URL);
  await expect(step.getByTestId('workflow-fix')).toHaveText(ru('actions.pr.opened', { n: 42 }));

  current = readiness({ workflow: { status: 'missing', pr: { number: 43, url: `https://github.com/${REPO}/pull/43`, provenance: 'foreign' } } });
  await page.getByTestId('actions-check-again').click();
  await expect(step.getByTestId('workflow-fix')).toHaveText(ru('actions.pr.foreign', { n: 43 }));
  await expect(step).not.toContainText('Смержите');

  current = readiness({ workflow: { status: 'missing', pr: { number: 44, url: `https://github.com/${REPO}/pull/44`, provenance: 'changed' } } });
  await page.getByTestId('actions-check-again').click();
  await expect(step.getByTestId('workflow-fix')).toHaveText(ru('actions.pr.foreign', { n: 44 }));
});

test('every answer of the workflow-PR route has its own words', async ({ page }) => {
  await answerReadiness(page, () => readiness({ workflow: { status: 'missing' } }));
  const branches = `https://github.com/${REPO}/branches/all?query=team-console%2Frunner-`;
  const cases: { answer: ReturnType<typeof problem>; check: (step: ReturnType<Page['getByTestId']>) => Promise<void> }[] = [
    {
      answer: problem(409, 'actions-setup-pr-open', { number: 7, url: `https://github.com/${REPO}/pull/7`, provenance: 'console' }),
      check: async (step) => {
        await expect(step.getByTestId('workflow-link-pr')).toHaveText(new RegExp(ru('actions.pr.view', { n: 7 })));
        await expect(step.getByTestId('workflow-link-pr')).toBeFocused();
      },
    },
    {
      answer: problem(409, 'actions-setup-branch-exists', { link: branches }),
      check: async (step) => {
        await expect(step.getByTestId('workflow-refusal')).toContainText(ru('actions.pr.err.branchExists'));
        await expect(step.getByTestId('workflow-refusal-link')).toHaveAttribute('href', branches);
        await expect(step.getByTestId('workflow-file')).toBeVisible();
      },
    },
    {
      answer: problem(409, 'actions-setup-pr-tampered'),
      check: (step) => expect(step.getByTestId('workflow-refusal')).toContainText(ru('actions.pr.err.tampered')),
    },
    {
      answer: problem(422, 'actions-permission-missing', { permissions: ['workflows', 'pull_requests'], link: INSTALLATION_URL }),
      check: async (step) => {
        await expect(step.getByTestId('workflow-refusal')).toContainText(ru('actions.pr.err.permission', { permissions: 'workflows, pull_requests' }));
        await expect(step.getByTestId('workflow-refusal-link')).toHaveAttribute('href', INSTALLATION_URL);
      },
    },
    {
      answer: problem(422, 'actions-setup-ready'),
      check: (step) => expect(step.getByTestId('workflow-refusal')).toContainText(ru('actions.pr.err.ready')),
    },
    {
      answer: problem(422, 'actions-setup-downgrade', { pins: ['runner'] }),
      check: (step) => expect(step.getByTestId('workflow-refusal')).toContainText(ru('actions.pr.err.downgrade', { branch: 'по умолчанию', pins: 'runner' })),
    },
    {
      answer: problem(503, 'github-write-disabled'),
      check: async (step) => {
        await expect(step.getByTestId('workflow-copy-reason')).toHaveText(ru('actions.wf.prOff'));
        await expect(step.getByTestId('workflow-open-pr')).toHaveCount(0);
        await expect(step.getByTestId('workflow-file')).toBeVisible();
      },
    },
    {
      answer: { ...problem(429, 'rate-limited'), headers: { 'Retry-After': '1800' } } as ReturnType<typeof problem>,
      check: (step) => expect(step.getByTestId('workflow-rate')).toBeVisible(),
    },
  ];
  for (const { answer, check } of cases) {
    await page.unroute(PR_API);
    await page.route(PR_API, (route) => route.fulfill(answer));
    await openPage(page);
    const step = page.getByTestId('workflow-step');
    await step.getByTestId('workflow-open-pr').click();
    await check(step);
  }
});

test('ready: «Включить» switches on, focuses the summary; a not-ready refusal names the items', async ({ page }) => {
  let current = readiness();
  await answerReadiness(page, () => current);
  let refuse = true;
  await page.route(DISPATCH_API, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.fallback();
      return;
    }
    await route.fulfill(
      refuse
        ? problem(422, 'actions-not-ready', { field: 'dispatch', items: ['workflow', 'secret'] })
        : { json: { dispatch: 'actions', defaultBranch: 'main' } },
    );
  });
  await openPage(page);
  await expect(page.getByTestId('actions-summary')).toContainText(ru('actions.sum.ready'));
  await page.getByTestId('switch-on').click();
  await expect(page.getByTestId('switch-error')).toHaveText(
    ru('runners.err.actionsNotReady', { project: SLUG, items: `${ru('actions.item.secret')}, ${ru('actions.item.workflow')}` }),
  );

  refuse = false;
  current = readiness();
  await page.getByTestId('switch-on').click();
  await expect(page.getByRole('heading', { level: 2, name: ru('actions.sum.on') })).toBeFocused();
  await expect(page.getByTestId('switch-done')).toHaveText(ru('actions.switch.done'));
  await expect(page.getByTestId('actions-open-project')).toBeVisible();
  await expectAccessible(page, 'GitHub Actions setup, switched on');
});

test('a member gets no setup row, and no readiness check is made', async ({ page }) => {
  // The seeded owner is replayed as a member of the same account (`GET …/dispatch` would answer a member 200 too).
  await page.route('**/api/v1/accounts', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { accounts: { role: string }[] };
    await route.fulfill({ response, json: { accounts: body.accounts.map((account) => ({ ...account, role: 'member' })) } });
  });
  const { calls } = await answerReadiness(page, () => problem(403, 'owner-only'));
  const accounts = page.waitForResponse('**/api/v1/accounts');
  await page.goto(`/settings/projects/${SLUG}`);
  await accounts;
  await expect(page.getByTestId('team-entry')).toBeVisible();
  await expect(page.getByTestId('check-again')).toHaveText(ru('settings.setup.checkAgain'));
  await expect(page.getByTestId('project-actions-entry')).toHaveCount(0);
  expect(calls()).toBe(0);
});

test('a member sees the forbidden state and no steps', async ({ page }) => {
  await answerReadiness(page, () => problem(403, 'owner-only'));
  await openPage(page);
  await expect(page.getByTestId('actions-forbidden')).toContainText(ru('actions.err.forbidden.title'));
  await expect(page.getByTestId('actions-ledger')).toHaveCount(0);
  await expectAccessible(page, 'GitHub Actions setup, member');
});

test('GitHub unavailable: an error block with Retry, then the steps', async ({ page }) => {
  let failing = true;
  await answerReadiness(page, () => (failing ? problem(502, 'github-unavailable') : readiness()));
  await openPage(page);
  await expect(page.getByTestId('actions-error')).toContainText(ru('actions.err.github'));
  failing = false;
  await page.getByTestId('actions-retry').click();
  await expect(page.getByTestId('actions-ledger')).toBeVisible();
});

test('Runners: choosing GitHub Actions shows the readiness line; Save waits and points to the page', async ({ page }) => {
  const { calls } = await answerReadiness(page, () => readiness({ secret: { status: 'missing' }, workflow: { status: 'missing' } }));
  await page.goto('/settings/runners');
  await page.getByTestId('runners-policy-pick').selectOption(SLUG);
  const editor = page.getByTestId('runners-dispatch');
  await expect(editor.getByTestId('project-dispatch-form')).toBeVisible();
  expect(calls()).toBe(0);
  await editor.getByRole('radio', { name: ru('runners.dispatch.actions') }).check();
  await expect(editor.getByTestId('project-dispatch-readiness')).toHaveText(new RegExp('Репозиторий ещё не готов: не хватает 2 шагов'));
  expect(calls()).toBe(1);
  // The radio never navigates (WCAG 3.2.2).
  await expect(page).toHaveURL(/\/settings\/runners$/);
  const save = editor.getByTestId('project-dispatch-save');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await save.focus();
  await page.keyboard.press('Enter');
  const prepare = editor.getByTestId('project-dispatch-prepare');
  await expect(prepare).toBeFocused();
  await expectAccessible(page, 'Settings › Runners, Actions not ready');
  await prepare.click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}\\?from=runners$`));
});

test('phone: no horizontal scroll with the file open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await answerReadiness(page, () => readiness({ environment: { status: 'missing' }, workflow: { status: 'missing' } }));
  await openPage(page);
  await page.getByTestId('workflow-show-file').click();
  await expect(page.getByTestId('workflow-file')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
