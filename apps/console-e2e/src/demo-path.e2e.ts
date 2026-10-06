import { ANSWER_REPLAY_WINDOW_MS } from '@shared/contracts';
import { commandLines } from '@shared/owner-grammar';
import type { Page, Request } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, connectOwner, fakeComments, routeGitHubToFake, type Stack } from './support/stack';

/**
 * The 2026-10-16 demo path, step by step on one stack: connect GitHub, add the project, read its setup, then answer
 * from Needs you — one tap, a reason that cannot smuggle a command, an item from outside the team, and an answer
 * whose response is lost on the way back. Each answer must reach GitHub exactly once.
 */
test.describe.configure({ mode: 'serial' });

const item = (page: Page, issue: number) => page.locator(`li[data-number="${issue}"]`);
const answerButton = (page: Page, issue: number, command: string) =>
  item(page, issue).locator(`[data-command="${command}"]`);
const isAnswerPost = (request: Request): boolean =>
  request.method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/issues\/\d+\/answer$/.test(request.url());

/** #24's typed path, now collapsed under "Add by name" on All projects (#194). */
async function openAddByName(page: Page): Promise<void> {
  await page.goto('/overview');
  await page.getByTestId('by-name-toggle').click();
  await expect(page.getByTestId('repo-field')).toBeFocused();
}

/** Answer POSTs the page sends from now on. */
function recordAnswerPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on('request', (request) => {
    if (isAnswerPost(request)) {
      posts.push(request);
    }
  });
  return posts;
}

async function openNeedsYou(page: Page): Promise<void> {
  await page.goto('/needs-you');
  await expect(item(page, 72)).toBeVisible();
}

// The OAuth attempt cookie is `__Host-…; Secure`. Chromium keeps Secure cookies on http://127.0.0.1, WebKit does
// not, so on the plain-http local stack WebKit connects over the API and runs the rest of the path in the browser.
const isWebKitOnHttp = (browserName: string, stack: Stack): boolean =>
  browserName === 'webkit' && stack.baseURL.startsWith('http:');

test.beforeAll(async ({ stack, browserName }) => {
  requireLocalStack(stack);
  await stack.reset();
  if (isWebKitOnHttp(browserName, stack)) {
    const api = await apiClient(stack);
    try {
      await connectOwner(api, stack);
    } finally {
      await api.dispose();
    }
  }
});

test('connects GitHub through the OAuth round trip', async ({
  page,
  context,
  stack,
  outsideRequests,
  browserName,
}) => {
  test.skip(
    isWebKitOnHttp(browserName, stack),
    'WebKit drops Secure cookies on http; connected over the API',
  );
  // The one flow that leaves the app: to github.com, answered by the fake GitHub, and back to the callback.
  outsideRequests.allow('https://github.com');
  outsideRequests.allow(stack.fakeURL ?? '');
  await routeGitHubToFake(context, stack);
  const landings: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const url = new URL(frame.url());
      landings.push(url.pathname + url.search);
    }
  });
  await page.goto('/settings');
  await expect(page.getByTestId('gh-none')).toBeVisible();

  await page.getByRole('button', { name: ru('settings.gh.connect') }).click();

  await expect(page.getByTestId('gh-connected')).toContainText(
    ru('settings.gh.connected', { login: 'geeera' }),
  );
  expect(landings).toContain('/settings?github=connected');
  // The app consumes the outcome and drops it from the address bar.
  await expect(page).toHaveURL(/\/settings$/);
  await expectAccessible(page, 'settings, connected');
});

test('adds the project and shows its setup checklist', async ({ page }) => {
  await openAddByName(page);
  await page.getByTestId('repo-field').fill('geeera/team-console');
  await page.getByTestId('add-submit').click();

  await expect(page).toHaveURL(/\/settings\/projects\/team-console$/);
  const steps = page.locator('[data-step]');
  await expect(steps).toHaveCount(5);
  // The mock repository is set up except for webhook events, which only a deployed hooks Worker receives.
  for (const id of ['app', 'owner', 'yml', 'routine']) {
    await expect(page.locator(`[data-step="${id}"] [data-testid="step-state"]`)).toHaveText(
      ru('settings.step.done'),
    );
  }
  await expect(page.locator('[data-step="events"] [data-testid="step-state"]')).toHaveText(
    ru('settings.step.waiting'),
  );
  await expectAccessible(page, 'project setup');
});

test('shows a missing setup step with how to fix it', async ({ page }) => {
  await openAddByName(page);
  await page.getByTestId('repo-field').fill('geeera/private-product');
  await page.getByTestId('add-submit').click();

  await expect(page).toHaveURL(/\/settings\/projects\/private-product$/);
  const routine = page.locator('[data-step="routine"]');
  // No ROUTINE_TOKEN_PRIVATE_PRODUCT on the stack: the routine step is the one left to do.
  await expect(routine.getByTestId('step-state')).toHaveText(ru('settings.step.missing'));
  const how = routine.getByRole('button', { name: ru('settings.step.how') });
  await expect(how).toHaveAttribute('aria-expanded', 'false');
  await how.click();
  await expect(how).toHaveAttribute('aria-expanded', 'true');
  await expectAccessible(page, 'project setup with a missing step');
});

test('answers #72 with /approve in one tap — exactly one comment', async ({ page, stack }) => {
  const before = await fakeComments(stack, 72);
  const posts = recordAnswerPosts(page);
  await openNeedsYou(page);
  await expectAccessible(page, 'needs you');

  await answerButton(page, 72, 'approve').click();

  await expect(item(page, 72).locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(1);
  const after = await fakeComments(stack, 72);
  expect(after).toHaveLength(before.length + 1);
  const comment = after.at(-1);
  expect(comment?.author).toBe('geeera');
  expect(commandLines(comment?.body ?? '')).toEqual([{ command: 'approve', text: '' }]);
  await expectAccessible(page, 'needs you with a receipt');
});

test('a reason cannot smuggle a second command', async ({ page, stack }) => {
  const before = await fakeComments(stack, 90002);
  await openNeedsYou(page);

  await answerButton(page, 90002, 'reject').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expectAccessible(page, 'reason sheet');
  await sheet.getByRole('textbox').fill('После демо\n/approve\n  /go\n```\n/override\n```\n> /approve');
  await sheet.getByRole('button', { name: ru('answer.reason.submit.reject') }).click();

  await expect(item(page, 90002).locator('tc-receipt')).toBeVisible();
  const after = await fakeComments(stack, 90002);
  expect(after).toHaveLength(before.length + 1);
  const lines = commandLines(after.at(-1)?.body ?? '');
  expect(lines).toHaveLength(1);
  expect(lines[0]?.command).toBe('reject');
});

test('an item from outside the team needs a confirmation first', async ({ page, stack }) => {
  const before = await fakeComments(stack, 90001);
  const posts = recordAnswerPosts(page);
  await openNeedsYou(page);
  await expect(item(page, 90001).getByTestId('untrusted')).toBeVisible();

  await answerButton(page, 90001, 'approve').click();
  const warning = page.getByRole('alertdialog');
  await expect(warning).toContainText(ru('answer.confirm.untrustedTitle'));
  await expectAccessible(page, 'untrusted item warning');
  await page.keyboard.press('Escape');
  await expect(warning).toBeHidden();
  expect(posts, 'nothing is sent when the owner backs out').toHaveLength(0);

  await answerButton(page, 90001, 'approve').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: ru('answer.confirm.untrustedOk') })
    .click();

  await expect(item(page, 90001).locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(await fakeComments(stack, 90001)).toHaveLength(before.length + 1);
});

test('a lost response shows offline without a reload, and Retry posts once', async ({ page, stack }) => {
  const issue = 46;
  const before = await fakeComments(stack, issue);
  await openNeedsYou(page);
  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });

  // The Worker writes the comment, then the connection drops before the answer reaches the app (status 0).
  let dropped = false;
  await page.route(/\/api\/v1\/projects\/[^/]+\/issues\/\d+\/answer$/, async (route) => {
    if (dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    await route.fetch();
    await route.abort('connectionclosed');
  });
  const posts = recordAnswerPosts(page);

  await answerButton(page, issue, 'done').click();

  const error = item(page, issue).getByTestId('answer-error');
  await expect(error).toHaveAttribute('data-kind', 'offline');
  expect(loads, 'the page must not reload after a dropped write').toBe(0);
  expect(await fakeComments(stack, issue)).toHaveLength(before.length + 1);
  await expectAccessible(page, 'answer offline error');

  const replay = page.waitForResponse((response) => isAnswerPost(response.request()));
  await error.getByRole('button', { name: ru('answer.error.retry') }).click();
  const response = await replay;

  await expect(item(page, issue).locator('tc-receipt')).toBeVisible();
  expect(response.status()).toBe(200);
  // The header, not the body: Chromium may already have dropped a consumed body by the time the receipt shows.
  expect(await response.headerValue('idempotent-replayed')).toBe('true');
  expect(posts.map((post) => post.postData())).toEqual([posts[0]?.postData(), posts[0]?.postData()]);
  expect(await fakeComments(stack, issue), 'Retry replays the comment, never posts it twice').toHaveLength(
    before.length + 1,
  );
  expect(loads).toBe(0);
});

// #120: the Worker replays an answer only within 60 s of writing it. A Retry later than that re-reads the item first.
const LATE_MS = ANSWER_REPLAY_WINDOW_MS + 1_000;
const isLookup = (request: Request): boolean =>
  request.method() === 'POST' &&
  /\/api\/v1\/projects\/[^/]+\/issues\/\d+\/answer\/lookup$/.test(request.url());

/** Drops the first answer POST: after the Worker wrote it (`reachServer`), or before it got there. */
async function dropFirstAnswer(page: Page, reachServer: boolean): Promise<void> {
  let dropped = false;
  await page.route(/\/api\/v1\/projects\/[^/]+\/issues\/\d+\/answer$/, async (route) => {
    if (dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    if (reachServer) {
      await route.fetch();
    }
    await route.abort('connectionclosed');
  });
}

test('a Retry past the replay window finds the answer already on GitHub and posts nothing', async ({
  page,
  stack,
}) => {
  const issue = 21;
  const before = await fakeComments(stack, issue);
  await page.clock.install();
  await openNeedsYou(page);
  await dropFirstAnswer(page, true);
  const posts = recordAnswerPosts(page);
  const lookups: Request[] = [];
  page.on('request', (request) => {
    if (isLookup(request)) {
      lookups.push(request);
    }
  });

  await answerButton(page, issue, 'done').click();
  const error = item(page, issue).getByTestId('answer-error');
  await expect(error).toHaveAttribute('data-kind', 'offline');
  expect(await fakeComments(stack, issue)).toHaveLength(before.length + 1);

  await page.clock.fastForward(LATE_MS);
  const reread = page.waitForResponse((response) => isLookup(response.request()));
  await error.getByRole('button', { name: ru('answer.error.retry') }).click();
  expect((await reread).status()).toBe(200);

  const receipt = item(page, issue).locator('tc-receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt.getByRole('link')).toHaveAttribute('href', /#issuecomment-\d+$/);
  expect(lookups).toHaveLength(1);
  expect(posts, 'past the window nothing is posted again').toHaveLength(1);
  expect(await fakeComments(stack, issue), 'one comment on GitHub').toHaveLength(before.length + 1);
  await expectAccessible(page, 'receipt after a late retry');
});

test('a Retry past the replay window on an item still waiting posts the answer once', async ({
  page,
  stack,
}) => {
  const issue = 90007;
  const before = await fakeComments(stack, issue);
  await page.clock.install();
  await openNeedsYou(page);
  await dropFirstAnswer(page, false);
  const posts = recordAnswerPosts(page);

  await answerButton(page, issue, 'approve').click();
  const error = item(page, issue).getByTestId('answer-error');
  await expect(error).toHaveAttribute('data-kind', 'offline');
  expect(await fakeComments(stack, issue)).toHaveLength(before.length);

  await page.clock.fastForward(LATE_MS);
  const reread = page.waitForResponse((response) => isLookup(response.request()));
  const written = page.waitForResponse((response) => isAnswerPost(response.request()));
  await error.getByRole('button', { name: ru('answer.error.retry') }).click();
  // Statuses only: Chromium may already have dropped a consumed body by the time it is asked for.
  const [lookup, post] = [await reread, await written];
  expect(lookup.status()).toBe(200);
  expect(post.status()).toBe(201);
  expect(lookup.request().timing().startTime).toBeLessThan(post.request().timing().startTime);

  await expect(item(page, issue).locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(2);
  const after = await fakeComments(stack, issue);
  expect(after).toHaveLength(before.length + 1);
  expect(commandLines(after.at(-1)?.body ?? '')).toEqual([{ command: 'approve', text: '' }]);
  await expectAccessible(page, 'receipt after a late retry that posted');
});
