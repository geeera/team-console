import { commandLines } from '@shared/owner-grammar';
import type { Page, Request } from '@playwright/test';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { fakeComments, seed } from './support/stack';

/**
 * Designs and demo (#20) on the fixture repository: the designs waiting for approval (#90004 with a Storybook
 * prototype and hostile markdown, #90006 with a prototype off the allow-list) and the open demo (#90005, a link-only stage),
 * answered in place. Frames load only from the project's embed origins, which the test serves locally; any other
 * request off the app origin fails the test.
 */
test.describe.configure({ mode: 'serial' });

const STORYBOOK = 'https://team-console-storybook.pages.dev';
const STAGE = 'https://team-console-stage.geeera.workers.dev';
const SECTION = '/p/team-console/demo';

const card = (page: Page, issue: number) => page.locator(`li[data-number="${issue}"]`);
const isAnswerPost = (request: Request): boolean =>
  request.method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/issues\/\d+\/answer$/.test(request.url());

function recordAnswerPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on('request', (request) => {
    if (isAnswerPost(request)) {
      posts.push(request);
    }
  });
  return posts;
}

/** Answers the one embed origin with a small accessible page instead of the internet; stage is never requested. */
async function servePreviews(page: Page, allow: (origin: string) => void): Promise<void> {
  for (const [origin, name] of [[STORYBOOK, 'Storybook']] as const) {
    allow(origin);
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="en"><head><title>${name}</title></head><body><main><h1>${name} preview</h1></main></body></html>`,
      }),
    );
  }
}

async function openSection(page: Page): Promise<void> {
  await page.goto(SECTION);
  await expect(card(page, 90004)).toBeVisible();
}

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('lists the designs waiting for approval and the open demo, with previews only from allowed origins', async ({
  page,
  outsideRequests,
}) => {
  await servePreviews(page, (origin) => outsideRequests.allow(origin));
  await openSection(page);

  // Inbox order: the release decision first, then the designs; nothing else of the inbox.
  await expect(page.locator('li[data-number]')).toHaveCount(3);
  expect(
    await page.locator('li[data-number]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-number'))),
  ).toEqual(['90005', '90004', '90006']);
  await expect(page.getByRole('list', { name: ru('review.listLabel') })).toBeVisible();

  const design = card(page, 90004);
  const frame = design.locator('iframe');
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute(
    'src',
    `${STORYBOOK}/iframe.html?id=kit-frame--embedded&viewMode=story`,
  );
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  expect(sandbox.split(/\s+/).sort()).toEqual(
    ['allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin', 'allow-scripts'].sort(),
  );
  await frame.scrollIntoViewIfNeeded();
  await expect(design.frameLocator('iframe').getByRole('heading', { name: 'Storybook preview' })).toBeVisible();

  // The hostile part of the body: no element of it survives, the javascript: link has no target.
  const markdown = design.getByTestId('markdown');
  // The renderer arrives lazily; wait for the rendered prose, not the plain-text stand-in.
  await expect(markdown.locator('div.tc-markdown')).toBeVisible();
  await expect(markdown.locator('img, script, iframe, [onerror]')).toHaveCount(0);
  // #189: a refused image is named in the interface language.
  await expect(markdown).toContainText(ru('ui.markdown.image'));
  await expect(markdown).not.toContainText(/\bimage\b/);
  await expect(markdown.getByText('ссылка')).toBeVisible();
  expect(await markdown.locator('a:not([href])').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  for (const link of await markdown.locator('a[href^="https:"]').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }

  // A prototype off the allow-list is a note with a link, never a frame.
  const offList = card(page, 90006);
  await expect(offList.locator('iframe')).toHaveCount(0);
  await expect(offList.getByTestId('frame-refused')).toContainText(ru('ui.frame.refusedTitle'));
  const open = offList.getByTestId('frame-open');
  await expect(open).toHaveAttribute('href', 'https://storify-proto.pages.dev/onboarding');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(open).toHaveAttribute('target', '_blank');

  // Stage is link-only (behind Cloudflare Access; owner decision 2026-10-05): a note and Open, never a blank frame.
  const demo = card(page, 90005);
  await expect(demo.getByTestId('frame-refused')).toBeVisible();
  await expect(demo.locator('iframe')).toHaveCount(0);
  await expect(demo.getByTestId('frame-open')).toHaveAttribute('href', `${STAGE}/`);
  await expect(demo.getByTestId('markdown').locator('table td').first()).toHaveText('e2e');

  // Fits the phone: nothing widens the page past the viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'Designs and demo');
});

/** Script responses the page loads from now on, with their text. */
function recordScripts(page: Page): Promise<string>[] {
  const scripts: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') {
      scripts.push(response.text().catch(() => ''));
    }
  });
  return scripts;
}

// A string only DOMPurify's bundle contains.
const SANITISER_MARK = 'ALLOWED_URI_REGEXP';

test('Questions and Needs you never download the markdown renderer; Designs and demo does', async ({
  page,
  outsideRequests,
}) => {
  await servePreviews(page, (origin) => outsideRequests.allow(origin));
  const scripts = recordScripts(page);
  await page.goto('/needs-you');
  await expect(page.locator('li[data-number="72"]')).toBeVisible();
  await page.goto('/p/team-console/questions');
  await expect(page.locator('li[data-number="90004"]')).toBeVisible();
  expect((await Promise.all(scripts)).some((text) => text.includes(SANITISER_MARK))).toBe(false);

  await page.goto(SECTION);
  await expect(card(page, 90004).locator('div.tc-markdown')).toBeVisible();
  expect((await Promise.all(scripts)).some((text) => text.includes(SANITISER_MARK))).toBe(true);
});

test.describe('dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('axe: Designs and demo', async ({ page, outsideRequests }) => {
    await servePreviews(page, (origin) => outsideRequests.allow(origin));
    await openSection(page);
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await expectAccessible(page, 'Designs and demo (dark)');
  });
});

test('approves a design in one tap: exactly one /approve comment', async ({ page, stack, outsideRequests }) => {
  await servePreviews(page, (origin) => outsideRequests.allow(origin));
  const before = await fakeComments(stack, 90004);
  const posts = recordAnswerPosts(page);
  await openSection(page);

  await card(page, 90004).locator('[data-command="approve"]').click();

  await expect(card(page, 90004).locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(1);
  const after = await fakeComments(stack, 90004);
  expect(after).toHaveLength(before.length + 1);
  expect(after.at(-1)?.author).toBe('geeera');
  expect(commandLines(after.at(-1)?.body ?? '')).toEqual([{ command: 'approve', text: '' }]);
});

test('rejects a design only with a reason, from the keyboard', async ({ page, stack, outsideRequests }) => {
  await servePreviews(page, (origin) => outsideRequests.allow(origin));
  const before = await fakeComments(stack, 90006);
  const posts = recordAnswerPosts(page);
  await openSection(page);

  await card(page, 90006).locator('[data-command="reject"]').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(ru('answer.reason.title.reject'));
  await sheet.getByRole('button', { name: ru('answer.reason.submit.reject') }).click();
  await expect(sheet).toContainText(ru('answer.reason.required'));
  expect(posts, 'no reason, no comment').toHaveLength(0);
  await expectAccessible(page, 'Designs and demo, reason sheet');

  await sheet.getByRole('textbox').fill('Прототип должен быть в Storybook проекта');
  await sheet.getByRole('button', { name: ru('answer.reason.submit.reject') }).focus();
  await page.keyboard.press('Enter');

  await expect(card(page, 90006).locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(1);
  const after = await fakeComments(stack, 90006);
  expect(after).toHaveLength(before.length + 1);
  expect(commandLines(after.at(-1)?.body ?? '')).toEqual([
    { command: 'reject', text: 'Прототип должен быть в Storybook проекта' },
  ]);
});

test('go asks for confirmation first, then writes exactly one /go', async ({ page, stack, outsideRequests }) => {
  await servePreviews(page, (origin) => outsideRequests.allow(origin));
  const before = await fakeComments(stack, 90005);
  const posts = recordAnswerPosts(page);
  await openSection(page);
  const demo = card(page, 90005);
  await expect(demo.locator('[data-command]')).toHaveText([
    ru('answer.command.go'),
    ru('answer.command.no-go'),
    ru('answer.command.override'),
  ]);

  await demo.locator('[data-command="go"]').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(ru('answer.confirm.goTitle'));
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(posts, 'nothing is sent when the owner backs out').toHaveLength(0);

  await demo.locator('[data-command="go"]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: ru('answer.command.go') }).click();

  await expect(demo.locator('tc-receipt')).toBeVisible();
  expect(posts).toHaveLength(1);
  const after = await fakeComments(stack, 90005);
  expect(after).toHaveLength(before.length + 1);
  expect(commandLines(after.at(-1)?.body ?? '')).toEqual([{ command: 'go', text: '' }]);
});
