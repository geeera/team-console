import type { Page } from '@playwright/test';
import type { DesignManifestDto } from '@shared/contracts';
import { animationsSettled } from './support/axe';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { seed } from './support/stack';

/**
 * The design viewer (#277) on the fixture repository: design issue #90004 carries phone and Mac renders under
 * docs/design/90004-demo-screen at the head of its open pull request (#176). The Artifacts row shows a thumbnail and
 * opens the viewer — full screen at 390×844, a large dialog at 1440×900 — where ‹ Назад / Вперёд ›, ←/→ and a swipe
 * turn the screens, «Все экраны» lists them, and «Интерактивно» refuses the wireframe because GitHub Pages is not an
 * embed origin of the project. The api serves only the raster images: the SVG is never listed, a file whose bytes
 * lie about their type is refused, every image answer carries nosniff and a sandboxing CSP.
 */
test.describe.configure({ mode: 'serial' });

const ISSUE = 90004;
const MANIFEST = `/api/v1/projects/team-console/designs/${ISSUE}`;
const FOLDER = `docs/design/${ISSUE}-demo-screen`;

const row = (page: Page) => page.locator(`[data-testid="artifact"][data-issue="${ISSUE}"]`);
const dialog = (page: Page) => page.locator('tc-sheet-container[role="dialog"]');
const modeButton = (page: Page, mode: string) =>
  page.locator(`[data-testid="viewer-mode"][data-mode="${mode}"]`);
const deviceButton = (page: Page, device: string) =>
  page.locator(`[data-testid="viewer-device"][data-device="${device}"]`);

async function openArtifacts(page: Page): Promise<void> {
  await page.goto('/p/team-console/artifacts?type=design');
  await expect(row(page)).toBeVisible();
}

async function openViewer(page: Page): Promise<void> {
  await openArtifacts(page);
  await row(page).getByRole('button').click();
  await expect(dialog(page)).toBeVisible();
  await animationsSettled(page);
}

test.beforeAll(async ({ stack }) => {
  requireLocalStack(stack);
  await seed(stack, ['geeera/team-console']);
});

test('the api lists the raster screens at the pull request head, never the SVG, and serves them safely', async ({
  request,
}) => {
  const manifest = (await (await request.get(MANIFEST)).json()) as DesignManifestDto;
  expect(manifest.ref).toBe('pull-request');
  expect(manifest.sha).toBe('17600176001760017600176001760017600176aa');
  expect(manifest.screens.map((screen) => screen.file)).toEqual([
    'mac-01-list.png',
    'mac-02-detail.webp',
    'phone-01-list.png',
    'phone-02-detail.png',
    'phone-03-answer.jpg',
    'phone-04-loading.gif',
    'phone-09-broken.png',
  ]);
  // screens.json names the first phone screen; the rest caption from their file names.
  expect(manifest.screens.find((screen) => screen.file === 'phone-01-list.png')?.caption).toBe('Список дизайнов');
  expect(manifest.screens.find((screen) => screen.file === 'phone-02-detail.png')?.caption).toBe('detail');
  expect(manifest.interactive?.url).toBe(`https://geeera.github.io/team-console/${ISSUE}-demo-screen/wireframe.html`);
  expect(JSON.stringify(manifest)).not.toContain('.svg');

  const file = (path: string) => `${MANIFEST}/${manifest.sha}/file?path=${encodeURIComponent(path)}`;
  const png = await request.get(file(`${FOLDER}/phone-01-list.png`));
  expect(png.status()).toBe(200);
  expect(png.headers()['content-type']).toBe('image/png');
  expect(png.headers()['x-content-type-options']).toBe('nosniff');
  expect(png.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(png.headers()['content-disposition']).toBe('inline; filename="phone-01-list.png"');
  expect(png.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
  expect((await png.body()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  for (const [path, type] of [
    [`${FOLDER}/mac-02-detail.webp`, 'image/webp'],
    [`${FOLDER}/phone-03-answer.jpg`, 'image/jpeg'],
    [`${FOLDER}/phone-04-loading.gif`, 'image/gif'],
  ] as const) {
    const response = await request.get(file(path));
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toBe(type);
  }
  // Refused: the SVG and the HTML (never in the set), a traversal, and the PNG whose bytes are a GIF.
  for (const path of [`${FOLDER}/logo.svg`, `${FOLDER}/wireframe.html`, `${FOLDER}/../../.product-team/project.yml`]) {
    expect((await request.get(file(path))).status(), path).toBe(404);
  }
  expect((await request.get(file(`${FOLDER}/phone-09-broken.png`))).status()).toBe(415);
});

test('a design row shows its thumbnail and summary, and the viewer opens on the first screen of the device', async ({
  page,
  viewport,
}) => {
  await openArtifacts(page);
  const thumb = row(page).getByTestId('design-thumb');
  await expect(thumb).toBeVisible();
  expect(await thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(thumb).toHaveAttribute('alt', '');
  await expect(row(page).getByTestId('design-summary')).toHaveText(`#${ISSUE} · 7 экранов · iPhone и Mac`);
  await expect(row(page).getByTestId('artifact-awaiting')).toHaveText(ru('designs.row.awaiting'));
  await expect(row(page).getByRole('button')).toHaveAccessibleName(new RegExp(ru('designs.row.open')));
  await expectAccessible(page, 'Artifacts with design rows');

  await row(page).getByRole('button').click();
  const open = dialog(page);
  await expect(open).toBeVisible();
  await animationsSettled(page);
  await expect(open).toHaveAttribute('aria-modal', 'true');
  await expect(open.locator('.tc-sheet__close')).toBeFocused();

  const isPhone = (viewport?.width ?? 0) < 520;
  const box = await open.boundingBox();
  if (isPhone) {
    // Full screen on the iPhone.
    expect(box?.width).toBe(viewport?.width);
    expect(box?.height).toBe(viewport?.height);
    await expect(deviceButton(page, 'phone')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('viewer-position')).toHaveText('1 из 5 · Список дизайнов');
  } else {
    // The large dialog: 1200 wide, 840 tall or as tall as the viewport allows (spec §2, within dvh).
    expect(box?.width).toBe(1200);
    expect(box?.height).toBeGreaterThan(780);
    expect(box?.height).toBeLessThanOrEqual(840);
    await expect(deviceButton(page, 'mac')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('viewer-position')).toHaveText('1 из 2 · Список дизайнов (Mac)');
  }
  const img = page.getByTestId('viewer-screen');
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  // The whole screen is visible: the image fits the stage, so the stage does not scroll.
  expect(
    await page.getByTestId('viewer-stage').evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await expect(open.locator('iframe, [srcdoc], svg image, object')).toHaveCount(0);
  await expectAccessible(page, 'Design viewer, images');
});

test('the buttons, the arrow keys and a swipe move one screen; the position is announced; a broken file says so', async ({
  page,
}) => {
  await openViewer(page);
  await deviceButton(page, 'phone').click();
  const position = page.getByTestId('viewer-position');
  await expect(position).toHaveAttribute('aria-live', 'polite');
  await expect(position).toHaveText('1 из 5 · Список дизайнов');
  await expect(page.getByTestId('viewer-prev')).toHaveAttribute('aria-disabled', 'true');

  await page.getByTestId('viewer-next').click();
  await expect(position).toHaveText('2 из 5 · detail');
  await expect(page.getByTestId('viewer-next')).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('3 из 5 · answer');
  await page.keyboard.press('ArrowLeft');
  await expect(position).toHaveText('2 из 5 · detail');

  const stage = page.getByTestId('viewer-stage');
  const swipe = async (dx: number): Promise<void> => {
    await stage.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 200, clientY: 400, bubbles: true });
    await stage.dispatchEvent('pointerup', { pointerType: 'touch', clientX: 200 + dx, clientY: 404, bubbles: true });
  };
  await swipe(-120);
  await expect(position).toHaveText('3 из 5 · answer');
  await swipe(120);
  await expect(position).toHaveText('2 из 5 · detail');

  // The zoom toggle: 100% width inside the stage, which becomes the one scroller; the header and footer stay.
  const zoom = page.getByTestId('viewer-zoom');
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  await zoom.click();
  await expect(zoom).toHaveAttribute('aria-pressed', 'true');
  await expect(stage).toHaveAttribute('tabindex', '0');
  await expect(page.locator('.tc-sheet__head')).toBeInViewport();
  await expect(page.locator('.tc-sheet__foot')).toBeInViewport();
  await zoom.click();
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');

  // The last phone screen is a PNG whose bytes are a GIF: the api refuses it and the viewer says so.
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(position).toHaveText('5 из 5 · broken');
  await expect(page.getByTestId('viewer-screen-failed')).toContainText(ru('designs.viewer.state.failed.title'));
  await expect(page.getByTestId('viewer-next')).toHaveAttribute('aria-disabled', 'true');
  await expectAccessible(page, 'Design viewer, a screen that did not load');
});

test('«Все экраны» lists every screen of the device; a cell opens it in «Картинки»', async ({ page }) => {
  await openViewer(page);
  await deviceButton(page, 'phone').click();
  await modeButton(page, 'grid').click();
  await expect(modeButton(page, 'grid')).toHaveAttribute('aria-pressed', 'true');
  const cells = page.getByTestId('viewer-grid-item');
  await expect(cells).toHaveCount(5);
  await expect(cells.first()).toHaveAttribute('aria-current', 'true');
  await expect(cells.nth(1)).toHaveAccessibleName('Экран 2: detail');
  await expect(page.getByTestId('viewer-position')).toHaveCount(0);
  await expectAccessible(page, 'Design viewer, all screens');

  await cells.nth(1).click();
  await expect(modeButton(page, 'images')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('viewer-position')).toHaveText('2 из 5 · detail');
});

test('«Интерактивно» refuses the wireframe without an allowed GitHub Pages origin: no frame, a link instead', async ({
  page,
}) => {
  await openViewer(page);
  await modeButton(page, 'interactive').click();
  const refused = page.getByTestId('viewer-interactive-refused');
  await expect(refused).toContainText(ru('designs.viewer.state.interactiveRefused.title'));
  await expect(dialog(page).locator('iframe')).toHaveCount(0);
  const link = page.getByTestId('viewer-open-interactive');
  await expect(link).toHaveAttribute('href', `https://geeera.github.io/team-console/${ISSUE}-demo-screen/wireframe.html`);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  await expectAccessible(page, 'Design viewer, interactive refused');

  await refused.getByRole('button', { name: ru('designs.viewer.state.interactiveRefused.images') }).click();
  await expect(page.getByTestId('viewer-screen')).toBeVisible();
});

test('Esc closes the viewer and returns focus to the row that opened it', async ({ page }) => {
  await openViewer(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page).getByRole('button')).toBeFocused();
});
