import type { APIRequestContext, Page, Route } from '@playwright/test';
import { TEAM_CONFIG_SCHEMA, problemTypeOf, type TeamConfigDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, type Stack } from './support/stack';
import { tabTo } from './support/keyboard';
import { meetsMinTap } from './support/tap-target';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * Settings › Team (#688) end to end on the local stack: the owner opens Team from the project's settings, edits
 * roles, models and the budget with the keyboard alone, reviews and saves a revision; a revision saved meanwhile
 * shows the conflict and is never overwritten; 422, 403 and a dropped network keep the edits; a member sees values
 * only; the phone layout folds and never scrolls sideways. Only the member, 403 and network cases stub a response —
 * every save that succeeds is the real Worker's.
 */

const SLUG = 'team-console';
const URL = `/settings/projects/${SLUG}/team`;
const API = `/api/v1/projects/${SLUG}/team-config`;
const spaced = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

async function prepared(stack: Stack, workerIndex: number): Promise<APIRequestContext> {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(workerIndex, SLUG, 'TC');
  return apiClient(stack);
}

async function stored(api: APIRequestContext): Promise<TeamConfigDto> {
  const response = await api.get(API);
  expect(response.status()).toBe(200);
  return (await response.json()) as TeamConfigDto;
}

/** Opens Team; on the phone the folded sections are unfolded unless `unfold` is false. */
async function openTeam(page: Page, unfold = true): Promise<void> {
  await page.goto(URL);
  await expect(page.getByRole('heading', { level: 1, name: ru('teamConfig.title') })).toBeVisible();
  await expect(page.getByTestId('role-dev')).toBeVisible();
  if (unfold) {
    await unfoldAll(page);
  }
}

async function unfoldAll(page: Page): Promise<void> {
  for (const name of ['access', 'limits', 'rules']) {
    const toggle = page.getByTestId(`section-toggle-${name}`);
    if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
  }
}

/** Answers `GET …/team-config` with the real view, changed by `change`. */
async function routeView(page: Page, change: (view: TeamConfigDto) => TeamConfigDto): Promise<void> {
  await page.route(`**${API}`, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as TeamConfigDto) });
  });
}

async function editBudget(page: Page, value: string): Promise<void> {
  const field = page.getByTestId('input-budget.monthly_usd');
  await field.fill(value);
}

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

test('the owner opens Team, edits roles, a model and the budget by keyboard alone, reviews and saves a revision', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await page.goto(`/settings/projects/${SLUG}`);
    await page.getByTestId('team-entry').click();
    await expect(page).toHaveURL(new RegExp(`${URL}$`));
    await expect(page.getByTestId('role-dev')).toBeVisible();
    await unfoldAll(page);
    await expect(page.getByTestId('team-not-customised')).toHaveText(ru('teamConfig.notCustomised'));

    // The five never-off roles are locked with their reason; security has no switch.
    const orchestrator = page.getByTestId('role-orchestrator').getByRole('switch');
    await expect(orchestrator).toHaveAttribute('aria-disabled', 'true');
    await expect(orchestrator).toHaveAccessibleDescription(ru('teamConfig.role.locked'));
    await expect(page.getByTestId('role-security').getByRole('switch')).toHaveCount(0);
    // The suggested budget is a hint, never a value.
    await expect(page.getByTestId('input-budget.monthly_usd')).toHaveValue('');
    await expectAccessible(page, 'Settings › Team, loaded');

    // UI designer off with Space.
    const designer = page.getByTestId('role-ui-designer').getByRole('switch');
    await tabTo(page, designer, page.getByTestId('role-ux-designer').getByTestId('role-limits'));
    await page.keyboard.press('Space');
    await expect(designer).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('role-ui-designer').getByTestId('role-reason')).toHaveText(
      ru('teamConfig.role.off'),
    );

    // Developer on Fable 5.1 through the picker: only the allowed models, Haiku named as not available.
    const devModel = page.getByTestId('role-dev').getByTestId('role-model');
    await tabTo(page, devModel, page.getByTestId('role-dev').getByRole('switch'));
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog');
    await expect(picker.getByTestId('model-claude-haiku-4-5-20251001')).toHaveCount(0);
    await expect(picker.getByTestId('model-not-allowed')).toContainText('Haiku 4.5');
    await expectAccessible(page, 'Settings › Team, model picker');
    await tabTo(page, picker.getByTestId('model-claude-opus-5-5'));
    await page.keyboard.press('ArrowUp');
    await expect(picker.getByTestId('model-claude-fable-5-1')).toBeChecked();
    await tabTo(page, picker.getByTestId('model-done'));
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(devModel).toBeFocused();
    await expect(page.getByTestId('role-dev').getByTestId('role-override')).toHaveText(
      ru('teamConfig.role.override'),
    );

    const budget = page.getByTestId('input-budget.monthly_usd');
    await tabTo(page, budget, page.getByTestId('role-ui-designer').getByTestId('role-limits'));
    await page.keyboard.type('250');

    const bar = page.getByRole('region', { name: ru('teamConfig.bar.label') });
    await expect(bar.getByTestId('save-bar-count')).toHaveText(ru('teamConfig.bar.count.few', { n: 3 }));
    await tabTo(page, bar.getByTestId('save-bar-review'), bar.getByTestId('save-bar-discard'));
    await page.keyboard.press('Enter');

    const review = page.getByRole('dialog', { name: ru('teamConfig.review.title') });
    const table = review.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(table).toContainText('Fable 5.1');
    await expect(review).toContainText(ru('teamConfig.review.applies'));
    await expectAccessible(page, 'Settings › Team, review and save');
    // T4: markup in the reason is sent and stored as text.
    const reason = '<img src=x onerror=alert(1)>';
    await tabTo(page, review.getByTestId('review-reason'));
    await page.keyboard.type(reason);
    await tabTo(page, review.getByTestId('review-save'));
    await page.keyboard.press('Enter');

    const toast = page
      .getByRole('status')
      .filter({ hasText: ru('teamConfig.saved', { n: 1 }) })
      .first();
    await expect(toast).toBeVisible();
    // The kit toast (inverse --text on --bg) fades in over --dur-fade; once in, it is fully opaque.
    await expect(toast).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('team-title')).toBeFocused();
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('team-revision')).toContainText(ru('teamConfig.owner'));

    const view = await stored(api);
    expect(view.revision).toBe(1);
    expect(view.resolved.roles.dev.model).toBe('claude-fable-5-1');
    expect(view.resolved.roles['ui-designer'].enabled).toBe(false);
    expect(view.budget.monthly_usd).toBe(250);
    const revision = (await (await api.get(`${API}/revisions/1`)).json()) as { reason: string };
    expect(revision.reason).toBe(reason);
  } finally {
    await api.dispose();
  }
});

test('a revision saved meanwhile shows the conflict, never overwritten; keep my edits on top, by keyboard', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await openTeam(page);
    await editBudget(page, '300');
    // Someone else saves revision 1 while the page holds revision 0.
    const other = await api.put(API, {
      data: { config: { schema: TEAM_CONFIG_SCHEMA, sprint: { length_days: 21 } } },
      headers: { 'If-Match': '"0"' },
    });
    expect(other.status(), await other.text()).toBe(200);

    await tabTo(page, page.getByTestId('save-bar-review'), page.getByTestId('save-bar-discard'));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('dialog').getByTestId('review-save'));
    await page.keyboard.press('Enter');

    const banner = page.getByTestId('team-conflict');
    await expect(banner.getByRole('heading')).toBeFocused();
    await expect(banner.getByRole('heading')).toHaveText(
      ru('teamConfig.conflict.title', { who: ru('teamConfig.owner'), n: 1 }),
    );
    expect((await stored(api)).budget.monthly_usd).toBeNull();
    await expectAccessible(page, 'Settings › Team, conflict');

    await tabTo(page, banner.getByTestId('conflict-show'));
    await page.keyboard.press('Enter');
    await expect(banner.getByRole('table')).toContainText(ru('teamConfig.field.sprint.length_days'));
    await tabTo(page, banner.getByTestId('conflict-keep'), banner.getByTestId('conflict-show'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-conflict')).toHaveCount(0);
    await expect(page.getByTestId('input-sprint.length_days')).toHaveValue('21');
    await expect(page.getByTestId('input-budget.monthly_usd')).toHaveValue('300');

    await tabTo(page, page.getByTestId('save-bar-review'), page.getByTestId('save-bar-discard'));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('dialog').getByTestId('review-save'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('team-title')).toBeFocused();
    const view = await stored(api);
    expect(view.revision).toBe(2);
    expect(view.budget.monthly_usd).toBe(300);
    expect(view.resolved.sprint.length_days).toBe(21);
  } finally {
    await api.dispose();
  }
});

test('a 422 marks and focuses the named field; 403 and a dropped network keep the edits', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await openTeam(page);
    await editBudget(page, '150');
    let answer: 'invalid' | 'forbidden' | 'abort' | 'real' = 'invalid';
    await page.route(`**${API}`, async (route: Route) => {
      if (route.request().method() !== 'PUT' || answer === 'real') {
        await route.fallback();
        return;
      }
      if (answer === 'abort') {
        await route.abort('internetdisconnected');
        return;
      }
      const status = answer === 'invalid' ? 422 : 403;
      const type = answer === 'invalid' ? 'team-config-invalid' : 'owner-only';
      await route.fulfill({
        status,
        contentType: 'application/problem+json',
        json: {
          type: problemTypeOf(type),
          title: 'x',
          status,
          ...(answer === 'invalid' ? { field: 'roles.dev.max_turns' } : {}),
        },
      });
    });
    const save = async (): Promise<void> => {
      await page.getByTestId('save-bar-review').click();
      await page.getByRole('dialog').getByTestId('review-save').click();
    };

    await save();
    const limits = page.getByTestId('role-dev').getByTestId('role-limits');
    await expect(limits).toBeFocused();
    await expect(limits).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('role-dev').getByRole('alert')).toContainText(
      ru('teamConfig.field.role.max_turns'),
    );

    answer = 'abort';
    await save();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('review-error')).toHaveText(ru('teamConfig.review.failed'));
    await expect(dialog.getByTestId('review-save')).toHaveText(ru('teamConfig.common.retry'));
    answer = 'real';
    await dialog.getByTestId('review-save').click();
    await expect(page.getByTestId('team-title')).toBeFocused();
    expect((await stored(api)).budget.monthly_usd).toBe(150);

    answer = 'forbidden';
    await editBudget(page, '175');
    await save();
    const forbidden = page.getByTestId('team-forbidden');
    await expect(forbidden.getByRole('heading')).toHaveText(ru('teamConfig.notOwnerNow'));
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await expect(page.getByTestId('value-budget.monthly_usd')).toHaveText('175');
    expect((await stored(api)).budget.monthly_usd).toBe(150);
  } finally {
    await api.dispose();
  }
});

test('a member sees values only; the subscription says why it is off; the Batch API is unsupported', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await routeView(page, (view) => ({ ...view, canManage: false }));
    await openTeam(page);
    await expect(page.getByTestId('team-read-only')).toHaveText(ru('teamConfig.readOnly'));
    await expect(page.locator('main').getByRole('switch')).toHaveCount(0);
    await expect(page.locator('main').getByRole('textbox')).toHaveCount(0);
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await expectAccessible(page, 'Settings › Team, member');

    await page.unrouteAll({ behavior: 'wait' });
    await routeView(page, (view) => ({ ...view, subscriptionBlocked: true }));
    await openTeam(page);
    const subscription = page.getByTestId('access-subscription');
    await expect(subscription).toHaveAccessibleDescription(new RegExp(ru('teamConfig.access.blocked')));
    await expect(page.getByTestId('access-runners')).toHaveAttribute('href', '/settings/runners');
    const batch = page.getByTestId('cost-batch-api');
    await expect(batch).toHaveAttribute('aria-disabled', 'true');
    await expect(batch).toHaveAccessibleDescription(
      `${ru('teamConfig.rules.cost.batchReason')} ${ru('teamConfig.rules.cost.batchStatus')}`,
    );
  } finally {
    await api.dispose();
  }
});

test('choosing the subscription needs its warning ticked; with an API key it is a draft until saved', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    // Start on an API key, so choosing the subscription is the change.
    const start = await api.put(API, {
      data: { config: { schema: TEAM_CONFIG_SCHEMA, access: { source: 'api_key' } } },
      headers: { 'If-Match': '"0"' },
    });
    expect(start.status(), await start.text()).toBe(200);
    await openTeam(page);
    await expect(page.getByTestId('access-subscription')).toHaveAccessibleDescription(
      new RegExp(ru('teamConfig.access.risk').slice(0, 40)),
    );
    await page.getByTestId('access-subscription').click();
    const dialog = page.getByRole('alertdialog', { name: ru('teamConfig.access.confirmTitle') });
    await dialog.getByTestId('subscription-ok').click();
    await expect(dialog.getByRole('alert')).toHaveText(ru('teamConfig.access.understandMissing'));
    await expect(dialog.getByTestId('subscription-understand')).toBeFocused();
    await page.keyboard.press('Space');
    await dialog.getByTestId('subscription-ok').click();
    await expect(page.getByTestId('access-subscription')).toBeChecked();
    // Under a subscription the cost levers are off with their reason.
    await expect(page.getByTestId('cost-prompt-caching')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('cost-off')).toHaveText(ru('teamConfig.rules.cost.subOnly'));
    expect((await stored(api)).resolved.access.source).toBe('api_key');
  } finally {
    await api.dispose();
  }
});

test('on a 375 px phone the sections fold, nothing scrolls sideways and every target is 44 px', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openTeam(page, false);
    const access = page.getByTestId('section-toggle-access');
    await expect(access).toHaveAttribute('aria-expanded', 'false');
    await expect(access).toContainText(ru('teamConfig.value.subscription'));
    await expect(page.getByTestId('section-toggle-roles')).toHaveAttribute('aria-expanded', 'true');
    // The three presets stack in one column, each name whole (the approved phone wireframe), never truncated.
    const presets = page.getByTestId('preset-group').locator('label');
    const tops = await presets.evaluateAll((labels) =>
      labels.map((label) => label.getBoundingClientRect().top),
    );
    expect(new Set(tops).size).toBe(3);
    const truncated = await presets.evaluateAll((labels) =>
      labels.some((label) => {
        const text = label.querySelector<HTMLElement>('.tc-segment__text');
        return text !== null && text.scrollWidth > text.clientWidth + 1;
      }),
    );
    expect(truncated).toBe(false);
    for (const name of ['access', 'limits', 'rules']) {
      await page.getByTestId(`section-toggle-${name}`).click();
    }
    await editBudget(page, '120');
    await expect(page.getByTestId('save-bar')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const scrollers = [
        document.documentElement,
        ...document.querySelectorAll<HTMLElement>('.tc-page-scroll'),
      ];
      return scrollers.some((element) => element.scrollWidth > element.clientWidth + 1);
    });
    expect(overflow).toBe(false);
    const targets = page.locator(
      '[data-testid^="role-"] [role="switch"], [data-testid="role-model"], [data-testid="role-limits"], [data-testid^="section-toggle-"], [data-testid^="save-bar-"]:is(button)',
    );
    for (const target of await targets.all()) {
      const box = await target.boundingBox();
      expect(
        meetsMinTap(box?.height),
        `${spaced(await target.textContent())} is ${String(box?.height)} px high`,
      ).toBe(true);
    }
    // Reduced motion: the save bar does not slide in.
    const duration = await page
      .getByTestId('save-bar')
      .evaluate((element) => getComputedStyle(element).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
    await expectAccessible(page, 'Settings › Team, phone');
  } finally {
    await api.dispose();
  }
});

test('leaving with unsaved edits asks first; a failed load offers Try again', async ({
  page,
  stack,
}, testInfo) => {
  const api = await prepared(stack, testInfo.workerIndex);
  try {
    let failing = true;
    await page.route(`**${API}`, async (route: Route) => {
      if (failing) {
        await route.fulfill({
          status: 503,
          json: { type: problemTypeOf('unavailable'), title: 'x', status: 503 },
        });
        return;
      }
      await route.fallback();
    });
    await page.goto(URL);
    const error = page.getByTestId('team-error');
    await expect(error).toContainText(ru('teamConfig.load.failTitle'));
    failing = false;
    await error.getByTestId('team-retry').click();
    await expect(page.getByTestId('role-dev')).toBeVisible();
    await unfoldAll(page);

    await editBudget(page, '90');
    await page.getByTestId('team-back').click();
    const leave = page.getByRole('alertdialog', { name: ru('teamConfig.leave.title') });
    await expect(leave).toContainText(ru('teamConfig.leave.body.one', { n: 1 }));
    await leave.getByRole('button', { name: ru('teamConfig.leave.stay') }).click();
    await expect(page).toHaveURL(new RegExp(`${URL}$`));
    await expect(page.getByTestId('input-budget.monthly_usd')).toHaveValue('90');
    await page.getByTestId('team-back').click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ru('teamConfig.leave.go') })
      .click();
    await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}$`));
    expect((await stored(api)).budget.monthly_usd).toBeNull();
  } finally {
    await api.dispose();
  }
});
