import type { Locator, Page } from '@playwright/test';
import type { TeamStatusDto } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, fakeComments, seed, type Stack } from './support/stack';

/**
 * A run log past 1000 comments (#143): GitHub lists comments oldest first, and the console reads the newest pages,
 * never the oldest ones. With 1250 comments on the log, the running run at its end is what the Commands panel's status
 * sees, and a pause written from the panel lands on page 13 and is read back as the owner's pause.
 */

const REPO = 'geeera/team-console';
const RUN_LOG = 22;
const STATUS = '/api/v1/projects/team-console/team/status';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OLD_COMMENTS = 1249;
const RUNNING = 'e2e-long-dev';
const isWide = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 520;

async function fakePost(stack: Stack, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${stack.fakeURL ?? ''}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok, `fake GitHub ${path}: ${await response.text()}`).toBe(true);
}

function entry(id: string, state: string, createdAt: number): Record<string, unknown> {
  return {
    repo: REPO,
    number: RUN_LOG,
    body: `<!-- pt-run id=${id} slot=slot-dev state=${state} -->\n**slot-dev** ${state}`,
    author: 'geeera',
    createdAt,
  };
}

/** Months of finished runs, then one dev run started 20 minutes ago as the newest comment. */
async function seedLongLog(stack: Stack): Promise<void> {
  await fakePost(stack, '/_fake/issue', {
    repo: REPO,
    number: RUN_LOG,
    title: 'Team run log',
    author: 'geeera',
    labels: ['team:run-log'],
    repoOwner: { login: 'geeera', id: 100001 },
  });
  const now = Date.now();
  const old = Array.from({ length: OLD_COMMENTS }, (_, i) =>
    entry(
      `old-${Math.floor(i / 2)}`,
      i % 2 === 0 ? 'started' : 'finished',
      now - 30 * DAY - (OLD_COMMENTS - i) * 30 * MINUTE,
    ),
  );
  // In order: the fake numbers comments as they arrive, and GitHub lists them oldest first.
  for (const body of old) {
    await fakePost(stack, '/_fake/comment', body);
  }
  await fakePost(stack, '/_fake/comment', entry(RUNNING, 'started', now - 20 * MINUTE));
}

const panelOf = (page: Page): Locator =>
  isWide(page) ? page.locator('#tc-overview-commands') : page.getByRole('dialog');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ stack }) => {
  test.setTimeout(180_000);
  requireLocalStack(stack);
  await seed(stack, [REPO]);
  await seedLongLog(stack);
});

// The fake GitHub outlives `seed`: leave an empty run log, as the next spec of this worker would find it.
test.afterAll(async ({ stack }) => {
  if (stack.isLocal) {
    await fakePost(stack, '/_fake/issue', {
      repo: REPO,
      number: RUN_LOG,
      title: 'Team run log',
      author: 'geeera',
      labels: ['team:run-log'],
      repoOwner: { login: 'geeera', id: 100001 },
    });
  }
});

test('a 1250-comment log: the newest running run locks dev, and a pause from the panel reads as the owner’s', async ({
  page,
  stack,
}) => {
  requireLocalStack(stack);
  const before = (await fakeComments(stack, RUN_LOG)).length;

  const api = await apiClient(stack);
  try {
    const loaded = await api.get(STATUS);
    expect(loaded.status(), await loaded.text()).toBe(200);
    const status = (await loaded.json()) as TeamStatusDto;
    expect(status.state).toBe('running');
    expect(status.slots.find((slot) => slot.slot === 'dev')?.lock).toMatchObject({
      kind: 'started',
      runId: RUNNING,
    });

    await page.goto('/overview');
    const open = page.getByRole('button', {
      name: ru('commands.openAria', {
        name: ((await page.locator('[data-card-slug="team-console"] .ov__name').textContent()) ?? '').trim(),
      }),
      exact: true,
    });
    await open.click();
    const panel = panelOf(page);
    await expect(panel.getByTestId('team-state')).toHaveClass(/cp-state__now--running/);

    await panel.getByTestId('team-command').click();
    const confirm = page.getByRole('alertdialog');
    await confirm.locator('.tc-confirm__ok').click();
    await expect(confirm).toHaveCount(0);
    await expect(panel.getByTestId('team-command')).toHaveAccessibleName(ru('commands.resume.title'));
    await expect(panel.getByTestId('team-state')).toHaveClass(/cp-state__now--paused-by-owner/);
    await expectAccessible(page, 'Commands panel on a 1250-comment run log, paused');

    // The pause is comment 1251 of the thread, on page 13: read back fresh, it is the owner's, with when.
    const written = await fakeComments(stack, RUN_LOG);
    expect(written).toHaveLength(before + 1);
    expect(written.at(-1)?.body.startsWith('<!-- pt-paused -->\n')).toBe(true);
    const paused = (await (await api.get(STATUS)).json()) as TeamStatusDto;
    expect(paused.state).toBe('paused-by-owner');
    expect(paused.pausedAt).not.toBeNull();

    const resumed = await api.post('/api/v1/projects/team-console/team/resume', { data: {} });
    expect(resumed.status(), await resumed.text()).toBe(201);
  } finally {
    await api.dispose();
  }
});
