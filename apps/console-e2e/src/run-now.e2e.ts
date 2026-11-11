import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { OWNER_ACCOUNT_ID, runnerAudienceOf, type ClaimResponse } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { apiClient, seed } from './support/stack';
import { switchToConsoleTracker } from './support/tracker-seed';

/**
 * Run now, the job view and the board's Run-log tile (#464, ADR 0008 row 2-E part B) end to end on a console-tracker
 * project: the owner queues a dev slot from the board, a repeat is refused while it is live, a real runner (enrolled
 * through the owner's one-time code, its own Ed25519 key) claims it and reports events, and the board shows the job
 * with that runner by name and its events, then the finished job with its summary. The runner's calls are the
 * runner's own HTTP API, no browser.
 */

const SLUG = 'team-console';

interface Runner {
  readonly id: string;
  readonly key: KeyObject;
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** A runner JWT as the runner binary mints one: EdDSA, `sub` the runner, this environment's audience, 4 minutes. */
function runnerJwt(runner: Runner): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'EdDSA' }));
  const claims = base64url(
    JSON.stringify({
      sub: runner.id,
      aud: runnerAudienceOf('local'),
      iat: now,
      exp: now + 240,
      jti: randomUUID(),
    }),
  );
  const signature = sign(null, Buffer.from(`${header}.${claims}`), runner.key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The owner's code, then the runner's own enrolment with a fresh key pair. */
async function enrolRunner(api: APIRequestContext): Promise<Runner> {
  const code = await api.post(`/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
    data: { name: 'E2E Mac', allowedProjects: [SLUG] },
  });
  expect(code.status(), await code.text()).toBe(201);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const enrolled = await api.post('/api/v1/runner/enrol', {
    data: {
      code: ((await code.json()) as { code: string }).code,
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      host: { os: 'darwin', arch: 'arm64', hostname: 'e2e-mac.local' },
      capabilities: { local: true, maxConcurrency: 1 },
      isolation: 'user',
      version: '0.3.0',
    },
  });
  expect(enrolled.status(), await enrolled.text()).toBe(201);
  return { id: ((await enrolled.json()) as { runnerId: string }).runnerId, key: privateKey };
}

async function asRunner(
  api: APIRequestContext,
  runner: Runner,
  path: string,
  data: unknown,
): Promise<unknown> {
  const response = await api.post(`/api/v1/runner${path}`, {
    data,
    headers: { Authorization: `Bearer ${runnerJwt(runner)}` },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  const text = await response.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
}

test.beforeEach(({ stack }) => {
  requireLocalStack(stack);
});

test('Run now queues a job, a runner claims it, and the board shows it with the runner, its events and the outcome', async ({
  page,
  stack,
}, testInfo) => {
  await seed(stack, ['geeera/team-console']);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
  const api = await apiClient(stack);
  try {
    const runner = await enrolRunner(api);

    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`/p/${SLUG}/board`);
    const tile = page.getByTestId('team-stat');
    const runs = page.getByTestId('runs');
    await expect(tile).toHaveAttribute('data-jobs', 'none');
    await expect(tile).toContainText(ru('jobs.tile.none'));
    await expect(runs.getByTestId('jobs-empty')).toContainText(ru('jobs.view.empty'));
    await expectAccessible(page, 'Board, console tracker, no jobs');

    // 1. Run now: the dev slot, queued; the card waits for a runner and the tile counts the queue.
    await runs.getByRole('combobox', { name: ru('jobs.runNow.kind') }).selectOption('slot-dev');
    await runs.getByTestId('run-now-submit').click();
    const kind = ru('jobs.kind.slot-dev');
    await expect(runs.getByTestId('run-now-outcome')).toHaveText(ru('jobs.runNow.queued', { kind }));
    const card = runs.getByTestId('jobs-current').getByTestId('job-card');
    await expect(card).toHaveAttribute('data-state', 'queued');
    await expect(card.getByTestId('job-runner')).toHaveText(ru('jobs.card.waitingForRunner'));
    await expect(tile).toContainText(ru('jobs.tile.queued', { n: '1' }));

    // 2. A repeat while it is live is the API's 409 job-exists, said under the button.
    await runs.getByTestId('run-now-submit').click();
    await expect(runs.getByTestId('run-now-error')).toHaveText(ru('jobs.err.exists'));
    await expect(runs.getByTestId('jobs-current').getByTestId('job-card')).toHaveCount(1);
    await expectAccessible(page, 'Board, one queued job, a refused repeat');

    // 3. The runner claims it and reports; Refresh shows it running on that runner with its events.
    const claim = (await asRunner(api, runner, '/jobs/claim', {})) as ClaimResponse;
    expect(claim.job.kind).toBe('slot-dev');
    await asRunner(api, runner, `/jobs/${claim.job.id}/events`, {
      events: [
        { level: 'info', kind: 'started', payload: { skill: 'slot-dev' } },
        { level: 'info', kind: 'log', payload: { line: 'Picked TC-1: Run now on the board' } },
      ],
    });
    await runs.getByTestId('jobs-refresh').click();
    await expect(card).toHaveAttribute('data-state', 'running');
    await expect(card.getByTestId('job-runner')).toHaveText('E2E Mac');
    await expect(card.getByTestId('job-event')).toHaveCount(3);
    await expect(card.getByTestId('job-events')).toContainText('Picked TC-1: Run now on the board');
    await expect(tile).toHaveAttribute('data-jobs', 'running');
    await expect(tile).toContainText(ru('jobs.tile.running', { kind }));
    await expectAccessible(page, 'Board, a running job with events');

    // 4. It finishes: the ended job moves to the recent list with its summary; the tile says how it ended.
    await asRunner(api, runner, `/jobs/${claim.job.id}/finish`, {
      result: 'finished',
      summary: 'Opened PR #512',
    });
    await runs.getByTestId('jobs-refresh').click();
    const recent = runs.getByTestId('jobs-recent').getByTestId('job-card');
    await expect(recent).toHaveAttribute('data-state', 'finished');
    await expect(recent.getByTestId('job-summary')).toHaveText('Opened PR #512');
    await expect(recent.getByTestId('job-runner')).toHaveText('E2E Mac');
    await expect(runs.getByTestId('jobs-empty')).toBeVisible();
    await expect(tile).toContainText(ru('jobs.tile.finished', { kind }));
  } finally {
    await api.dispose();
  }
});

test('a GitHub project keeps the run-log tile and offers no Run now', async ({ page, stack }) => {
  // A fresh stack without the switch: the project is on GitHub, so the board reads the run log, not the jobs.
  await seed(stack, ['geeera/team-console']);
  await page.goto(`/p/${SLUG}/board`);
  await expect(page.getByTestId('team-stat')).toHaveAttribute('data-team', /.+/);
  await expect(page.getByTestId('team-stat')).not.toHaveAttribute('data-jobs', /.+/);
  await expect(page.getByTestId('run-now')).toHaveCount(0);
});
