import { env } from 'cloudflare:test';
import { OWNER_ACCOUNT_ID, type NeedsYouDto } from '@shared/contracts';
import { enrolRunner, sendAsRunner } from '../testing/runner-kit';
import { seedTrackerProject, send } from '../testing/tracker-kit';

// #746 (ADR 0008 decision 6): `max_concurrency: 0` starts no job, and "Needs you" says why on the project's row.

const setOwnerEntitlements = (json: string) =>
  env.DB.prepare(`UPDATE accounts SET entitlements = ?2 WHERE id = ?1`).bind(OWNER_ACCOUNT_ID, json).run();

afterEach(async () => {
  await setOwnerEntitlements('{"max_concurrency":32}');
  // Needs you lists every active project of the owner's account; archive what a case registered.
  await env.DB.prepare(
    `UPDATE projects SET archived_at = '2026-11-05T00:00:00Z' WHERE archived_at IS NULL`,
  ).run();
});

async function needsYou(): Promise<NeedsYouDto> {
  const response = await send('GET', '/api/v1/needs-you');
  expect(response.status).toBe(200);
  return (await response.json()) as NeedsYouDto;
}

describe('GET /api/v1/needs-you: the concurrency stop (#746)', () => {
  it('names the project whose queued jobs cannot start while the account is entitled to none, and the claim agrees', async () => {
    const waiting = await seedTrackerProject();
    const idle = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { allowedProjects: [waiting.slug] });
    await setOwnerEntitlements('{"max_concurrency":0}');
    expect(
      (await send('POST', `/api/v1/projects/${waiting.slug}/jobs`, { kind: 'review', role: 'qa' })).status,
    ).toBe(201);
    expect(
      (await send('POST', `/api/v1/projects/${waiting.slug}/jobs`, { kind: 'review', role: 'security' }))
        .status,
    ).toBe(201);

    const claim = await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {});
    expect(claim.status).toBe(204);
    expect(claim.headers.get('Retry-After')).toBe('60');

    const body = await needsYou();
    expect(body.projects.find((row) => row.slug === waiting.slug)?.concurrencyStop).toEqual({
      queuedJobs: 2,
    });
    // No queued job, nothing held back: no row.
    expect(body.projects.find((row) => row.slug === idle.slug)?.concurrencyStop).toBeUndefined();

    await setOwnerEntitlements('{}');
    expect(
      (await needsYou()).projects.find((row) => row.slug === waiting.slug)?.concurrencyStop,
    ).toBeUndefined();
    expect((await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {})).status).toBe(200);
  });
});
