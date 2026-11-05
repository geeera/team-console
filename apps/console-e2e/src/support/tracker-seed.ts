import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { STACKS_DIR, WORKSPACE_ROOT } from '../stack/local-stack';

/**
 * Console-tracker seeding for the #435 specs. Nothing in the API switches a project to the console tracker yet (the
 * cutover is #437) and asks are job writes (Phase 2), so those two rows go straight into the worker's own local D1 —
 * the same database `LocalStack` migrated under `tmp/console-e2e/worker-<index>/api-state`. Never a remote D1: the
 * command is always `--local` with that `--persist-to`. Everything else goes through the owner's API like the app.
 */

const WRANGLER = join(WORKSPACE_ROOT, 'node_modules/.bin/wrangler');

/** Runs SQL on the local D1 of the Playwright worker `workerIndex`. The SQL is the spec's own constant text. */
export async function localD1(workerIndex: number, sql: string): Promise<void> {
  const persist = join(STACKS_DIR, `worker-${String(workerIndex)}`, 'api-state');
  await new Promise<void>((done, fail) => {
    const child = spawn(
      WRANGLER,
      [
        'd1',
        'execute',
        'team-console-dev',
        '--local',
        '--config',
        'apps/api/wrangler.jsonc',
        '--env',
        'dev',
        '--persist-to',
        persist,
        '--command',
        sql,
      ],
      { cwd: WORKSPACE_ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
    );
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`wrangler d1 execute: ${String(code)} ${errors}`)),
    );
  });
}

/** Moves a registered project onto the console tracker with key prefix `prefix` (what the cutover will do). */
export async function switchToConsoleTracker(
  workerIndex: number,
  slug: string,
  prefix: string,
): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(slug) || !/^[A-Z]{2,5}$/.test(prefix)) {
    throw new Error('slug or prefix is not a fixed fixture value');
  }
  await localD1(
    workerIndex,
    `UPDATE projects SET tracker = 'console', key_prefix = '${prefix}', cutover_at = '2026-11-01T00:00:00.000Z' WHERE slug = '${slug}'`,
  );
}

export interface SeedItem {
  readonly title: string;
  readonly body?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly sprint?: number | null;
}

/** `POST …/items` as the owner, with its idempotency key; answers the item number. */
export async function createItem(api: APIRequestContext, slug: string, item: SeedItem): Promise<number> {
  const response = await api.post(`/api/v1/projects/${slug}/items`, {
    data: { kind: 'feature', ...item },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  if (response.status() !== 201) {
    throw new Error(`create item: ${String(response.status())} ${await response.text()}`);
  }
  const body = (await response.json()) as { number: number };
  return body.number;
}

/** `POST …/sprints` as the owner. */
export async function createSprint(api: APIRequestContext, slug: string, dueOn: string): Promise<number> {
  const response = await api.post(`/api/v1/projects/${slug}/sprints`, {
    data: { dueOn },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
  if (response.status() !== 201) {
    throw new Error(`create sprint: ${String(response.status())} ${await response.text()}`);
  }
  return ((await response.json()) as { number: number }).number;
}

/** `PATCH …/items/:n` as someone else would, to make the owner's edit run into a newer version. */
export async function patchItem(
  api: APIRequestContext,
  slug: string,
  number: number,
  change: Record<string, unknown>,
): Promise<void> {
  const read = await api.get(`/api/v1/projects/${slug}/items/${String(number)}`);
  const etag = read.headers()['etag'] ?? '';
  const response = await api.patch(`/api/v1/projects/${slug}/items/${String(number)}`, {
    data: change,
    headers: { 'Idempotency-Key': crypto.randomUUID(), 'If-Match': etag },
  });
  if (!response.ok()) {
    throw new Error(`patch item: ${String(response.status())} ${await response.text()}`);
  }
}
