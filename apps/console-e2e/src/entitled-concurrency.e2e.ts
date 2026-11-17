import type { APIRequestContext } from '@playwright/test';
import { OWNER_ACCOUNT_ID } from '@shared/contracts';
import { expect, expectAccessible, requireLocalStack, test } from './support/fixtures';
import { ru } from './support/i18n';
import { claimStatus, enrolRunner } from './support/runner';
import { apiClient, seed } from './support/stack';
import { localD1, switchToConsoleTracker } from './support/tracker-seed';

/**
 * The account's entitled concurrency (#746, ADR 0008 decision 6) end to end on the local stack: real runners (enrolled
 * through the owner's code, their own Ed25519 keys) poll the claim over HTTP, and the operator's override is written
 * straight into the worker's local D1, as the operator route would. A free account's second runner gets 204 while
 * the first holds the account's one slot; `max_concurrency: 0` starts nothing and Needs you says why.
 */

const SLUG = 'team-console';

/** The operator's change to the owner's account: a fixed spec constant, never input. */
async function setOwnerAccount(workerIndex: number, plan: 'free' | 'team', entitlements: string): Promise<void> {
  if (!/^\{[a-z_":0-9,]*\}$/.test(entitlements)) {
    throw new Error('entitlements is not a fixed fixture value');
  }
  await localD1(
    workerIndex,
    `UPDATE accounts SET plan = '${plan}', entitlements = '${entitlements}' WHERE id = '${OWNER_ACCOUNT_ID}'`,
  );
}

async function review(api: APIRequestContext, role: string): Promise<void> {
  const queued = await api.post(`/api/v1/projects/${SLUG}/jobs`, { data: { kind: 'review', role } });
  expect(queued.status(), await queued.text()).toBe(201);
}

test.beforeEach(async ({ stack }, testInfo) => {
  requireLocalStack(stack);
  await seed(stack, [`geeera/${SLUG}`]);
  await switchToConsoleTracker(testInfo.workerIndex, SLUG, 'TC');
});

test('a free account with two runners runs one job at a time: the second claim gets 204', async ({ stack }, testInfo) => {
  await setOwnerAccount(testInfo.workerIndex, 'free', '{}');
  const api = await apiClient(stack);
  try {
    const mac = await enrolRunner(api, SLUG);
    const vps = await enrolRunner(api, SLUG);
    await review(api, 'qa');
    await review(api, 'security');
    expect(await claimStatus(api, mac)).toBe(200);
    expect(await claimStatus(api, vps)).toBe(204);
  } finally {
    await api.dispose();
  }
});

test('max_concurrency 0 starts no job, and Needs you says why until the operator lifts it', async ({
  page,
  stack,
}, testInfo) => {
  await setOwnerAccount(testInfo.workerIndex, 'team', '{"max_concurrency":0}');
  const api = await apiClient(stack);
  try {
    const mac = await enrolRunner(api, SLUG);
    await review(api, 'qa');
    expect(await claimStatus(api, mac)).toBe(204);
    const projects = (await (await api.get('/api/v1/projects')).json()) as { slug: string; displayName: string }[];
    const name = projects.find((project) => project.slug === SLUG)?.displayName ?? SLUG;

    await page.goto('/needs-you');
    const row = page.getByTestId('concurrency-stop');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveText(ru('needsYou.attention.noConcurrency', { name, n: 1 }));
    await expect(page.getByRole('list', { name: ru('needsYou.attention.label') })).toContainText(name);
    await expect(page.getByTestId('empty')).toHaveCount(0);
    await expectAccessible(page, 'Needs you, no concurrency entitled');
    await page.getByTestId('project-attention').screenshot({ path: test.info().outputPath('needs-you-concurrency.png') });

    await setOwnerAccount(testInfo.workerIndex, 'team', '{}');
    await page.reload();
    await expect(page.getByTestId('lead').or(page.getByTestId('empty')).first()).toBeVisible();
    await expect(page.getByTestId('concurrency-stop')).toHaveCount(0);
    expect(await claimStatus(api, mac)).toBe(200);
  } finally {
    await api.dispose();
  }
});
