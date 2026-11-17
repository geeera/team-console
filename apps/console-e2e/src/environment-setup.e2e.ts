import type { Page, Route } from '@playwright/test';
import type { TeamStatusDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed, seedFakeRunLog, type Stack } from './support/stack';

/**
 * Environment setup (#104), split by #750: the console's own rows on the operator screen `/admin/environment/:env`,
 * each project's rows on its own screen under its setup page. The local stack's api Worker runs as `local` with its
 * own `--var` flags (AUTH_MODE, GITHUB_MOCK, GITHUB_FAKE_ORIGIN, PUSH_FAKE_ORIGIN; no ROUTINES_FAKE_ORIGIN), so its
 * tab is "this console" and shows set and missing honestly; every other tab, and a project's production section, is
 * "not visible here". The 403 for the service identity and a session user is the api spec's
 * (`routes/environment.spec.ts`): the local stack has no Access, so the 403 screens are driven by a routed answer.
 */

const SLUG = 'team-console';
const OTHER = 'private-product';
const STATUS = '/api/v1/environment/status';

const isWide = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 900;

/** Values the local api Worker holds; none of them may reach the screen, its storage or the endpoint's body. */
function sentinels(stack: Stack): string[] {
  // GITHUB_FAKE_ORIGIN and ROUTINE_TOKEN_TEAM_CONSOLE as local-stack.ts passes them.
  return [...(stack.fakeURL === null ? [] : [stack.fakeURL]), 'local-fake-routine'];
}

async function expectNoValues(page: Page, stack: Stack): Promise<void> {
  const html = await page.content();
  const storage = await page.evaluate(() =>
    Object.keys(localStorage)
      .map((key) => `${key}=${localStorage.getItem(key) ?? ''}`)
      .join('\n'),
  );
  for (const value of sentinels(stack)) {
    expect(html, `DOM carries ${value}`).not.toContain(value);
    expect(storage, `storage carries ${value}`).not.toContain(value);
  }
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

async function openLocal(page: Page): Promise<void> {
  await page.goto('/admin/environment/local');
  await expect(page.getByRole('heading', { level: 1, name: ru('env.console.title') })).toBeFocused();
  await expect(page.getByTestId('env-summary')).toContainText(ru('env.sum.ok', { env: 'local' }));
}

/** `team-console`'s seven rows as a production console's Worker would report them, set but the given names. */
function productionStatus(missing: readonly string[]): object {
  const slots = ['PM', 'DEV', 'QA'].flatMap((slot) => [
    `SLOT_TOKEN_TEAM_CONSOLE_${slot}`,
    `SLOT_ROUTINE_TEAM_CONSOLE_${slot}`,
  ]);
  return {
    environment: 'production',
    items: ['ROUTINE_TOKEN_TEAM_CONSOLE', ...slots].map((name) => ({
      id: `project/${SLUG}/${name}`,
      status: missing.includes(name) ? 'missing' : 'set',
      optional: name !== 'ROUTINE_TOKEN_TEAM_CONSOLE',
    })),
  };
}

/** Answers the project's status call with `answer` (a body or a status code); the console's own call is untouched. */
async function routeProjectStatus(page: Page, answer: () => object | number): Promise<void> {
  await page.route(`**${STATUS}?project=${SLUG}`, async (route: Route) => {
    const body = answer();
    await (typeof body === 'number'
      ? route.fulfill({
          status: body,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://team-console.dev/problems/owner-only',
            title: 'Forbidden',
            status: body,
          }),
        })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  });
}

test.beforeEach(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console', 'geeera/private-product']);
});

test.describe('the operator screen (/admin/environment)', () => {
  test('Settings ends with the console operator’s row, which opens this console’s environment', async ({
    page,
  }) => {
    await page.goto('/settings');
    const section = page.getByTestId('env-section');
    await expect(section.getByRole('heading', { name: ru('env.console.section') })).toBeVisible();
    await expect(section.getByTestId('env-entry-chip')).toHaveText(ru('env.entry.ok'));
    await expectAccessible(page, 'Settings, console operator row');

    await section.getByRole('link', { name: new RegExp(ru('env.console.title')) }).click();
    await expect(page).toHaveURL(/\/admin\/environment\/local$/);
    await expect(page.getByRole('heading', { level: 1, name: ru('env.console.title') })).toBeFocused();
    await expect(page.getByRole('tab', { selected: true })).toHaveText(
      new RegExp(`local\\s*${ru('env.tab.this')}`),
    );
  });

  test('this console’s tab: set and missing from the Worker, a missing row has its fix with Copy', async ({
    page,
    context,
    stack,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLocal(page);

    const mock = page.locator('[data-row="local/GITHUB_MOCK"]');
    await expect(mock).toHaveAccessibleName(`GITHUB_MOCK, ${ru('env.st.set')}`);
    const missing = page
      .getByTestId('env-row')
      .filter({ has: page.locator('[data-row="local/ROUTINES_FAKE_ORIGIN"]') });
    await expect(missing.getByTestId('env-status')).toHaveText(ru('env.st.missing'));
    await expect(missing).toContainText(ru('env.st.optional'));
    // Missing first in its group.
    await expect(page.locator('[data-group="local"] [data-row]').first()).toHaveAttribute(
      'data-row',
      'local/ROUTINES_FAKE_ORIGIN',
    );
    const fix = missing.getByTestId('env-fix');
    await expect(fix.locator('code')).toHaveText('setup --env local');
    const copy = fix.getByRole('button', { name: ru('env.row.copyAria', { name: 'ROUTINES_FAKE_ORIGIN' }) });
    await copy.click();
    await expect(copy).toContainText(ru('settings.common.copied'));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('setup --env local');

    await expectNoValues(page, stack);
    await expectAccessible(page, 'Console environment, this console');
  });

  test('another environment: every item not visible here, and no per-project rows at all', async ({
    page,
    stack,
  }) => {
    await openLocal(page);
    const selected = page.getByRole('tab', { selected: true });
    await selected.focus();
    // The tabs read dev, stage, production, local: ← from local selects production (automatic activation).
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/\/admin\/environment\/production$/);
    await expect(page.getByRole('tab', { selected: true })).toBeFocused();

    const summary = page.getByTestId('env-summary');
    await expect(summary).toContainText(ru('env.sum.other', { this: 'local', env: 'production' }));
    await expect(summary.locator('code')).toHaveText('setup --env production --check');
    const statuses = await page.getByTestId('env-status').allTextContents();
    expect(statuses.length).toBeGreaterThan(10);
    expect(new Set(statuses.map((status) => status.trim()))).toEqual(new Set([ru('env.st.unseen')]));
    await expect(page.getByTestId('env-fix')).toHaveCount(0);
    // #750: the projects group moved to each project's own screen.
    await expect(page.locator('[data-group="projects"]')).toHaveCount(0);
    await expect(page.locator('[data-row^="project/"]')).toHaveCount(0);

    await expectNoValues(page, stack);
    await expectAccessible(page, 'Console environment, another environment');
  });

  test('a guide: from the manifest only, the command that fits, Back returns to the row', async ({
    page,
    stack,
  }) => {
    await page.goto('/admin/environment/production');
    const row = page.locator('[data-row="github-secrets/CLOUDFLARE_API_TOKEN"]');
    await row.click();

    await expect(page).toHaveURL(/\/admin\/environment\/production\/github-secrets\/CLOUDFLARE_API_TOKEN$/);
    const guide = page.getByTestId('env-guide');
    await expect(guide.getByRole('heading', { level: 1, name: 'CLOUDFLARE_API_TOKEN' })).toBeFocused();
    await expect(guide).toContainText(ru('env.g.never'));
    await expect(guide).toContainText('Workers Scripts: Edit');
    await expect(guide.getByTestId('env-guide-status')).toHaveText(ru('env.st.unseen'));
    await expect(guide.getByTestId('env-guide-how').locator('code')).toHaveText([
      'setup --env production --check',
      'setup --env production',
    ]);
    if (isWide(page)) {
      // A pane beside the list; the open row is marked.
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(row).toBeHidden();
    }
    await expectNoValues(page, stack);
    await expectAccessible(
      page,
      isWide(page) ? 'Console environment guide, pane' : 'Console environment guide, page',
    );

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/admin\/environment\/production$/);
    await expect(row).toBeFocused();
  });
});

test.describe('a project’s environment (/settings/projects/:slug/environment)', () => {
  test('the setup page’s row opens the project’s screen: only its rows, from its own scoped call', async ({
    page,
    stack,
  }) => {
    // Every status call passes through here, so its URL and body are kept as the browser got them.
    const answers: { url: string; body: string }[] = [];
    await page.route(`**${STATUS}*`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      answers.push({ url: route.request().url(), body });
      await route.fulfill({ response, body });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/settings/projects/${SLUG}`);
    const entry = page.getByTestId('project-env-entry');
    // Locally the project's secrets (production only) are not visible: the chip says it is not checked.
    await expect(entry).toContainText(ru('env.project.entry.sub', { env: 'production' }));
    await expect(entry.getByTestId('project-env-chip')).toHaveText(ru('env.entry.unknown'));
    await expectAccessible(page, 'Project setup, environment row');

    await entry.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}/environment$`));
    await expect(page.getByRole('heading', { level: 1, name: ru('env.project.title') })).toBeFocused();
    const section = page.getByTestId('env-section');
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(/^production/);
    await expect(section.getByTestId('env-summary')).toContainText(
      ru('env.sum.other', { this: 'local', env: 'production' }),
    );
    const rows = page.locator('[data-row]');
    await expect(rows).toHaveCount(7);
    for (const id of await rows.evaluateAll((links) =>
      links.map((link) => link.getAttribute('data-row') ?? ''),
    )) {
      expect(id.startsWith(`project/${SLUG}/`), id).toBe(true);
    }
    const statuses = await page.getByTestId('env-status').allTextContents();
    expect(new Set(statuses.map((status) => status.trim()))).toEqual(new Set([ru('env.st.unseen')]));
    await expect(page.getByTestId('env-quiet')).toHaveText(
      ru('env.project.none', {
        list: `dev, stage${ru('env.project.list.and')}${ru('env.project.list.local')}`,
      }),
    );

    // The network log: every status call named this project, and no answer named the other one.
    expect(answers.length).toBeGreaterThan(0);
    for (const { url, body } of answers) {
      expect(new URL(url).searchParams.get('project')).toBe(SLUG);
      expect(body).not.toContain(OTHER);
      expect(body).not.toContain('PRIVATE_PRODUCT');
    }
    // 375 px: the longest name wraps, nothing scrolls sideways; every row is a 44 px target.
    await expectNoHorizontalScroll(page);
    for (const box of await rows.evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height),
    )) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
    await expectNoValues(page, stack);
    await expectAccessible(page, 'Project environment, not visible here');
  });

  test('a project guide: its h1 takes focus, Escape returns to the row', async ({ page }) => {
    await page.goto(`/settings/projects/${SLUG}/environment`);
    const row = page.locator(`[data-row="project/${SLUG}/SLOT_ROUTINE_TEAM_CONSOLE_DEV"]`);
    await row.click();

    await expect(page).toHaveURL(
      new RegExp(`/settings/projects/${SLUG}/environment/production/SLOT_ROUTINE_TEAM_CONSOLE_DEV$`),
    );
    const guide = page.getByTestId('env-guide');
    await expect(
      guide.getByRole('heading', { level: 1, name: 'SLOT_ROUTINE_TEAM_CONSOLE_DEV' }),
    ).toBeFocused();
    await expect(guide).toContainText(ru('env.g.place.projects', { env: 'production', project: SLUG }));
    if (!isWide(page)) {
      // Its own page on the phone, with Back to the project's list; the Mac's pane has the close button instead.
      await expect(
        guide.getByRole('link', { name: new RegExp(ru('env.project.g.back', { project: SLUG })) }),
      ).toHaveAttribute('href', `/settings/projects/${SLUG}/environment`);
    }
    await expectAccessible(
      page,
      isWide(page) ? 'Project environment guide, pane' : 'Project environment guide, page',
    );

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}/environment$`));
    await expect(row).toBeFocused();
  });

  test('on a production console: the count, the fix, the first missing one, and Check again announces once', async ({
    page,
  }) => {
    let answer: object = productionStatus(['ROUTINE_TOKEN_TEAM_CONSOLE', 'SLOT_TOKEN_TEAM_CONSOLE_QA']);
    await routeProjectStatus(page, () => answer);
    await page.goto(`/settings/projects/${SLUG}/environment`);

    const section = page.getByTestId('env-section');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(
      new RegExp(`production\\s*,?\\s*${ru('env.project.this')}`),
    );
    const summary = section.getByTestId('env-summary');
    const missingTitle = 'Для team-console в production не задана 1 обязательная настройка';
    await expect(summary.getByRole('heading', { level: 3 })).toHaveText(missingTitle);
    await expect(summary.locator('code')).toHaveText('setup --env production');
    const required = page
      .getByTestId('env-row')
      .filter({ has: page.locator(`[data-row="project/${SLUG}/ROUTINE_TOKEN_TEAM_CONSOLE"]`) });
    await expect(required.getByTestId('env-fix').locator('code')).toHaveText('setup --env production');
    // A missing optional row never warns and has no fix line.
    const optional = page
      .getByTestId('env-row')
      .filter({ has: page.locator(`[data-row="project/${SLUG}/SLOT_TOKEN_TEAM_CONSOLE_QA"]`) });
    await expect(optional.getByTestId('env-status')).toHaveText(ru('env.st.missing'));
    await expect(optional.getByTestId('env-fix')).toHaveCount(0);
    await expectAccessible(page, 'Project environment, one required missing');

    await summary.getByTestId('env-jump').click();
    await expect(page.locator(`[data-row="project/${SLUG}/ROUTINE_TOKEN_TEAM_CONSOLE"]`)).toBeFocused();

    answer = productionStatus(['SLOT_TOKEN_TEAM_CONSOLE_QA']);
    await summary.getByTestId('env-recheck').click();
    const allSet = 'Для team-console в production задано всё обязательное';
    await expect(summary.getByRole('heading', { level: 3 })).toHaveText(allSet);
    await expect(page.getByTestId('env-optional-left')).toHaveText(
      ru('env.project.sum.optionalLeft', { n: 1 }),
    );
    await expect(page.locator('.cdk-live-announcer-element')).toHaveText(allSet);
  });

  test('a sign-in that may not see the project’s secrets (403) sees no row names, and a way back', async ({
    page,
  }) => {
    await routeProjectStatus(page, () => 403);
    await page.goto(`/settings/projects/${SLUG}/environment`);

    await expect(page.getByRole('heading', { level: 1, name: ru('env.project.title') })).toBeFocused();
    const forbidden = page.getByTestId('env-forbidden');
    await expect(forbidden).toContainText(ru('env.project.err.forbidden.title'));
    await expect(page.locator('[data-row]')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('ROUTINE_TOKEN');
    await expectAccessible(page, 'Project environment, forbidden');

    await forbidden.getByRole('link', { name: ru('env.project.err.forbidden.back') }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/projects/${SLUG}$`));
    // The setup page shows no environment row to that sign-in either.
    await expect(page.getByTestId('setup-result')).toBeVisible();
    await expect(page.getByTestId('project-env-entry')).toHaveCount(0);
  });

  test('the commands pane’s “not set up” refusal links to that slot’s token guide', async ({
    page,
    stack,
  }) => {
    await seedFakeRunLog(stack);
    // Locally no slot has a trigger token; the status is told otherwise so Run now can be pressed and refused.
    await page.route(`**/api/v1/projects/${SLUG}/team/status*`, async (route) => {
      const response = await route.fetch();
      const status = (await response.json()) as TeamStatusDto;
      await route.fulfill({
        response,
        json: { ...status, slots: status.slots.map((slot) => ({ ...slot, setup: 'present' })) },
      });
    });
    await page.goto(`/p/${SLUG}/questions`);
    await page.getByTestId('commands-open').click();
    await page.getByTestId('run-qa').click();
    const confirm = page.getByRole('alertdialog');
    await confirm.locator('.tc-confirm__ok').click();
    await expect(confirm.getByRole('alert')).toContainText(
      ru('commands.error.notConfigured', { slot: ru('commands.slot.qa') }),
    );
    const link = confirm.getByRole('link', { name: ru('commands.error.setLink') });
    await expectAccessible(page, 'Run now refused, not set up');

    await link.click();
    await expect(page).toHaveURL(
      new RegExp(`/settings/projects/${SLUG}/environment/production/SLOT_TOKEN_TEAM_CONSOLE_QA$`),
    );
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(
      page.getByTestId('env-guide').getByRole('heading', { level: 1, name: 'SLOT_TOKEN_TEAM_CONSOLE_QA' }),
    ).toBeFocused();
  });
});

test.describe('old addresses redirect (#750 UX spec §7)', () => {
  test('an old project guide opens the project’s guide, query and fragment kept, the old address not in history', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.goto(
      `/settings/environment/production/project/${SLUG}/ROUTINE_TOKEN_TEAM_CONSOLE?from=mail#how`,
    );
    await expect(page).toHaveURL(
      new RegExp(
        `/settings/projects/${SLUG}/environment/production/ROUTINE_TOKEN_TEAM_CONSOLE\\?from=mail#how$`,
      ),
    );
    await expect(
      page.getByTestId('env-guide').getByRole('heading', { level: 1, name: 'ROUTINE_TOKEN_TEAM_CONSOLE' }),
    ).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('the old console screen and its guides open the operator screen', async ({ page }) => {
    await page.goto('/settings/environment/local');
    await expect(page).toHaveURL(/\/admin\/environment\/local$/);
    await expect(page.getByRole('heading', { level: 1, name: ru('env.console.title') })).toBeFocused();

    await page.goto('/settings/environment');
    await expect(page).toHaveURL(/\/admin\/environment\/local$/);

    await page.goto('/settings/environment/production/api/OWNER_EMAIL');
    await expect(page).toHaveURL(/\/admin\/environment\/production\/api\/OWNER_EMAIL$/);
    await expect(
      page.getByTestId('env-guide').getByRole('heading', { level: 1, name: 'OWNER_EMAIL' }),
    ).toBeFocused();
  });
});

/**
 * The `env.*` copy chunks (#104), by content rather than by their hashed filename: a marker from each one's
 * `console.lead` string, present nowhere else in the bundle.
 */
const COPY_CHUNK_MARKERS = ['Секреты и переменные самой консоли', 'The console’s own secrets and variables'];

test('environment copy: Try again that fails again falls back to a full reload, not a frozen SPA error', async ({
  page,
}) => {
  await page.route('**/*.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (COPY_CHUNK_MARKERS.some((marker) => body.includes(marker))) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ response });
  });

  await page.goto('/admin/environment/local');
  await expect(page.getByTestId('env-copy-failed')).toBeVisible();

  // A real reload, not just the SPA re-trying in place: waiting for the frame's next `load` event is how to tell.
  await Promise.all([page.waitForEvent('load'), page.getByTestId('env-copy-retry').click()]);

  // The outage is still simulated: the reloaded page shows the same readable error, not a blank or stuck screen.
  await expect(page.getByTestId('env-copy-failed')).toBeVisible();
});

test('the status endpoint carries presence only, scoped: the console’s rows, or one project’s', async ({
  stack,
}) => {
  const api = await apiClient(stack);
  try {
    const response = await api.get(STATUS);
    expect(response.status()).toBe(200);
    const text = await response.text();
    for (const value of sentinels(stack)) {
      expect(text).not.toContain(value);
    }
    const body = JSON.parse(text) as { environment: string; items: { id: string; status: string }[] };
    expect(body.environment).toBe('local');
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'optional', 'status']);
      expect(['set', 'missing']).toContain(item.status);
      expect(item.id.startsWith('project/'), item.id).toBe(false);
    }

    const scoped = await api.get(`${STATUS}?project=${SLUG}`);
    expect(scoped.status()).toBe(200);
    // Locally the project's secrets (production only) have no row.
    expect(await scoped.json()).toEqual({ environment: 'local', items: [] });

    const unknown = await api.get(`${STATUS}?project=zz-no-such-project`);
    expect(unknown.status()).toBe(404);
    expect(((await unknown.json()) as { type: string }).type).toMatch(/project-not-found$/);
    expect((await api.get(`${STATUS}?project=Not_A_Slug`)).status()).toBe(400);
  } finally {
    await api.dispose();
  }
});
