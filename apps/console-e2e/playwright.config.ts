import { defineConfig, devices } from '@playwright/test';

/**
 * console-e2e (#14). Each worker starts its own local stack (fake GitHub + the api bundle on a fresh local D1, see
 * src/stack/local-stack.ts) unless `BASE_URL` names a running target — a Docker container or stage. For stage,
 * `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (the Access service token, from the environment's secrets) are
 * sent on every request; specs that reset data or need the fake GitHub skip themselves there.
 */
const isCI = process.env['CI'] !== undefined && process.env['CI'] !== '';
const accessId = process.env['CF_ACCESS_CLIENT_ID'];
const accessSecret = process.env['CF_ACCESS_CLIENT_SECRET'];
const accessHeaders: Record<string, string> =
  accessId !== undefined && accessId !== '' && accessSecret !== undefined && accessSecret !== ''
    ? { 'CF-Access-Client-Id': accessId, 'CF-Access-Client-Secret': accessSecret }
    : {};

const iphone = devices['iPhone 13'];
// The demo device: a 390 px wide iPhone (the 2026-10-16 demo runs on one).
const iphoneViewport = { width: 390, height: 844 };

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.ts',
  outputDir: '../../dist/.playwright/apps/console-e2e/test-output',
  fullyParallel: false,
  forbidOnly: isCI,
  // No retries: a flaky step is a bug to fix, and a retried answer would hit the 60 s replay window anyway.
  retries: 0,
  // Two stacks of two wrangler processes each plus the browsers fit a CI runner and a laptop alike.
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: '../../dist/.playwright/apps/console-e2e/report' }],
      ]
    : [['list']],
  use: {
    locale: 'ru-RU',
    timezoneId: 'Europe/Kyiv',
    // The service worker would answer some requests itself, out of reach of page.route() and the request guard.
    serviceWorkers: 'block',
    extraHTTPHeaders: accessHeaders,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'iphone',
      use: {
        browserName: 'chromium',
        viewport: iphoneViewport,
        deviceScaleFactor: iphone.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        userAgent: iphone.userAgent,
      },
    },
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      // Safari's engine on the demo path only: the flow the owner runs on the phone.
      name: 'iphone-webkit',
      testMatch: '**/demo-path.e2e.ts',
      use: { ...iphone, viewport: iphoneViewport },
    },
  ],
});
