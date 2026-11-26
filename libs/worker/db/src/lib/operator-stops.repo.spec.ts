import { env } from 'cloudflare:test';
import { OperatorStopsRepo } from './operator-stops.repo';

// #759 PR 4 (SEC 4): the operator's stop of the Actions setup write, a row the Worker only ever reads
// (`tools/workspace-checks/src/actions-setup-kill-switch.spec.ts` pins that no code writes the table).

const STOP = `INSERT INTO operator_stops (name, stopped_at, reason) VALUES (?1, ?2, ?3)`;

describe('OperatorStopsRepo', () => {
  const repo = new OperatorStopsRepo(env.DB);

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM operator_stops`).run();
  });

  it('is not stopped while the table holds no row, and stopped once the operator wrote one', async () => {
    expect(await repo.isStopped('actions-setup-write')).toBe(false);
    await env.DB.prepare(STOP).bind('actions-setup-write', '2026-11-18T10:00:00Z', 'incident #1').run();
    expect(await repo.isStopped('actions-setup-write')).toBe(true);
  });

  it.each([
    ['an unknown name', ['something-else', '2026-11-18T10:00:00Z', 'x']],
    ['a time that is not UTC ISO', ['actions-setup-write', 'yesterday', 'x']],
    ['an empty reason', ['actions-setup-write', '2026-11-18T10:00:00Z', '']],
    ['a reason longer than 200 characters', ['actions-setup-write', '2026-11-18T10:00:00Z', 'r'.repeat(201)]],
  ])('refuses %s', async (_case, values) => {
    await expect(
      env.DB.prepare(STOP)
        .bind(...values)
        .run(),
    ).rejects.toThrow();
  });
});
