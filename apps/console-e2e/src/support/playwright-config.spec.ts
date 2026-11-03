import type { PlaywrightTestConfig } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #142: the suite's config with and without the Access token. With it, nothing may record request headers (traces,
 * the HTML report) and the token never goes into `extraHTTPHeaders`, which Playwright sends to every origin.
 */

async function configWith(env: Record<string, string>): Promise<PlaywrightTestConfig> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  return (await import('../../playwright.config')).default;
}

function reporterNames(config: PlaywrightTestConfig): string[] {
  const reporter = config.reporter;
  if (reporter === undefined) {
    return [];
  }
  return typeof reporter === 'string' ? [reporter] : reporter.map(([name]) => name);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('playwright.config', () => {
  it('never puts the Access token into extraHTTPHeaders and keeps no trace or HTML report with it', async () => {
    const config = await configWith({
      CI: 'true',
      BASE_URL: 'https://team-console-stage.example.dev',
      CF_ACCESS_CLIENT_ID: ['dummy', 'id'].join('-'),
      CF_ACCESS_CLIENT_SECRET: ['dummy', 'secret'].join('-'),
    });

    expect(JSON.stringify(config)).not.toContain(['dummy', 'secret'].join('-'));
    expect(config.use?.extraHTTPHeaders).toBeUndefined();
    expect(config.use?.trace).toBe('off');
    expect(reporterNames(config)).not.toContain('html');
    for (const project of config.projects ?? []) {
      expect(project.use?.trace, project.name).toBeUndefined();
      expect(project.use?.extraHTTPHeaders, project.name).toBeUndefined();
    }
  });

  it('keeps traces of failures and the HTML report in CI without the Access token', async () => {
    const config = await configWith({ CI: 'true', CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' });

    expect(config.use?.trace).toBe('retain-on-failure');
    expect(reporterNames(config)).toContain('html');
  });
});
