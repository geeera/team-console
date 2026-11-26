import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createLogger } from '@worker/core';
import type { ApiEnv } from '../env';
import { localEnv } from '../testing/github-kit';
import worker from '../main';
import { runLoggedSweep, sweepEnrolmentIntents } from './sweep';

// #821: the Cron's retention sweep of `runner_enrolment_requests`. What a row's retention is, boundary included, is
// `EnrolmentIntentsRepo.deleteRetired`'s spec; here it is the wiring and what a failure leaves behind.

const ACCOUNT = '01M6YSNJ0000000000000SW821';
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (hours: number): string => new Date(NOW - hours * 3600_000).toISOString();

let counter = 0;
async function intentExpiredAt(expiresAt: string): Promise<string> {
  counter += 1;
  const id = `01M6YSNJ0000000000000SW${String(counter).padStart(3, '0')}`;
  const createdAt = new Date(Date.parse(expiresAt) - 600_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO runner_enrolment_requests (id, account_id, name, project_scope, isolation, created_by, created_at, expires_at)
     VALUES (?1, ?2, 'mac', 'all', 'user', 'owner', ?3, ?4)`,
  )
    .bind(id, ACCOUNT, createdAt, expiresAt)
    .run();
  return id;
}

const exists = async (id: string): Promise<boolean> =>
  (await env.DB.prepare(`SELECT 1 AS hit FROM runner_enrolment_requests WHERE id = ?1`).bind(id).first()) !==
  null;

function capturingLogger(): { logger: ReturnType<typeof createLogger>; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: 'spec' }, (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { logger, lines };
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO accounts (id, slug, name, created_at) VALUES (?1, 'sw821', 'S', ?2)`)
    .bind(ACCOUNT, ago(48))
    .run();
});

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM runner_enrolment_requests`).run();
});

describe('the Cron sweep: enrolment intent retention (#821)', () => {
  it('deletes the rows a day past their use and keeps the recent ones, logging the count', async () => {
    const old = await intentExpiredAt(ago(25));
    const recent = await intentExpiredAt(ago(23));
    const { logger, lines } = capturingLogger();

    await sweepEnrolmentIntents(localEnv(), new Date(NOW), logger);

    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', message: 'enrolment intents swept', deleted: 1 }),
    ]);
  });

  it('logs nothing when there is nothing to delete', async () => {
    await intentExpiredAt(ago(1));
    const { logger, lines } = capturingLogger();
    await sweepEnrolmentIntents(localEnv(), new Date(NOW), logger);
    expect(lines).toEqual([]);
  });

  it('runs from the Worker’s scheduled handler', async () => {
    const old = await intentExpiredAt(ago(25));
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: '*/5 * * * *' }), localEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(await exists(old)).toBe(false);
  });

  it('logs a failed sweep by the error’s name only and rethrows it, so the invocation fails', async () => {
    const broken = {
      ...localEnv(),
      DB: {
        prepare: () => {
          throw new Error('D1_ERROR: no such table: runner_enrolment_requests');
        },
      },
    } as unknown as ApiEnv;
    const { logger, lines } = capturingLogger();

    await expect(
      runLoggedSweep(logger, 'enrolment intent sweep failed', () =>
        sweepEnrolmentIntents(broken, new Date(NOW), logger),
      ),
    ).rejects.toThrow(/D1_ERROR/);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'error', message: 'enrolment intent sweep failed', error: 'Error' }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('no such table');
  });
});
