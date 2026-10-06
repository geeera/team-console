import { isEnvironment, type Environment } from '@shared/contracts';
import type { APIRequestContext } from '@playwright/test';
import { expect, expectAccessible, test } from './support/fixtures';
import { ru } from './support/i18n';

/**
 * The installed app says which environment it is (#237). Read-only, so it holds on any target: the local stack and
 * the Docker image run as `local`, stage as `stage`; production would show no mark at all.
 */

const NAMES: Readonly<Record<Environment, { name: string; shortName: string; label: string | null }>> = {
  local: { name: 'Team Console Local', shortName: 'TC Local', label: 'Local' },
  dev: { name: 'Team Console Dev', shortName: 'TC Dev', label: 'Dev' },
  stage: { name: 'Team Console Stage', shortName: 'TC Stage', label: 'Stage' },
  production: { name: 'Team Console', shortName: 'Console', label: null },
};

async function environmentOf(request: APIRequestContext): Promise<Environment> {
  const response = await request.get('/api/v1/healthz');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { environment?: unknown };
  if (!isEnvironment(body.environment)) {
    throw new Error(`healthz names no environment: ${JSON.stringify(body)}`);
  }
  return body.environment;
}

test('the manifest and the Home Screen icons carry the environment', async ({ page }) => {
  const environment = await environmentOf(page.request);
  const expected = NAMES[environment];

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  const body = (await manifest.json()) as { name: string; short_name: string; icons: { src: string }[] };
  expect(body.name).toBe(expected.name);
  expect(body.short_name).toBe(expected.shortName);
  for (const { src } of body.icons) {
    expect(src.startsWith(`/icons/${environment}/`), src).toBe(true);
    const icon = await page.request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()['content-type'], src).toBe('image/png');
  }

  for (const [path, type] of [
    ['/brand/apple-touch-icon.png', 'image/png'],
    ['/brand/favicon.ico', 'image/vnd.microsoft.icon'],
  ] as const) {
    const icon = await page.request.get(path);
    expect(icon.status(), path).toBe(200);
    expect(icon.headers()['content-type'], path).toBe(type);
    const original = await page.request.get(`/icons/${environment}/${path.slice('/brand/'.length)}`);
    expect(Buffer.compare(await icon.body(), await original.body()), path).toBe(0);
  }
});

test('the window title, the iOS title and the shell mark name the environment', async ({ page }) => {
  const environment = await environmentOf(page.request);
  const expected = NAMES[environment];

  await page.goto('/needs-you');

  await expect(page).toHaveTitle(expected.name);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', expected.name);
  const mark = page.getByTestId('environment-mark');
  if (expected.label === null) {
    await expect(mark).toHaveCount(0);
  } else {
    // Text, not colour alone: the label is visible and a screen reader hears what it is.
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(new RegExp(`^\\s*${ru('app.environment')}\\s*${expected.label}\\s*$`));
  }
  await expectAccessible(page, 'shell with the environment mark');
});
