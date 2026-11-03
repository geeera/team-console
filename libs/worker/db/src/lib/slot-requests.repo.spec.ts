import { env } from 'cloudflare:test';
import { SlotRequestsRepo } from './slot-requests.repo';

const repo = (): SlotRequestsRepo => new SlotRequestsRepo(env.DB);

describe('SlotRequestsRepo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM slot_requests').run();
  });

  it('claims a free slot and finds the request as locking', async () => {
    const id = await repo().claim('storify', 'dev', '2026-10-01T12:00:00.000Z', '2026-10-01T11:45:00.000Z');
    expect(id).not.toBeNull();
    await expect(repo().findLocking('storify', 'dev', '2026-10-01T11:45:00.000Z')).resolves.toMatchObject({
      slug: 'storify',
      slot: 'dev',
      requestedAt: '2026-10-01T12:00:00.000Z',
      state: 'pending',
      sessionId: null,
    });
  });

  it('refuses a second claim while a newer request exists, and two taps together claim once', async () => {
    const claims = await Promise.all([
      repo().claim('storify', 'dev', '2026-10-01T12:00:00.000Z', '2026-10-01T11:45:00.000Z'),
      repo().claim('storify', 'dev', '2026-10-01T12:00:00.001Z', '2026-10-01T11:45:00.001Z'),
    ]);
    expect(claims.filter((id) => id !== null)).toHaveLength(1);
  });

  it('a request at or before the cut-off (older than 15 minutes, or a started run after it) no longer locks', async () => {
    await repo().claim('storify', 'dev', '2026-10-01T12:00:00.000Z', '2026-10-01T11:45:00.000Z');
    await expect(
      repo().claim('storify', 'dev', '2026-10-01T12:20:00.000Z', '2026-10-01T12:00:00.000Z'),
    ).resolves.not.toBeNull();
  });

  it('keeps slots and projects apart', async () => {
    await repo().claim('storify', 'dev', '2026-10-01T12:00:00.000Z', '2026-10-01T11:45:00.000Z');
    await expect(
      repo().claim('storify', 'qa', '2026-10-01T12:00:01.000Z', '2026-10-01T11:45:00.000Z'),
    ).resolves.not.toBeNull();
    await expect(
      repo().claim('other', 'dev', '2026-10-01T12:00:01.000Z', '2026-10-01T11:45:00.000Z'),
    ).resolves.not.toBeNull();
  });

  it('settles a request, releases one that started nothing, and prunes old rows', async () => {
    const fired = await repo().claim('storify', 'pm', '2026-10-01T12:00:00.000Z', '2026-10-01T11:45:00.000Z');
    await repo().settle(fired ?? 0, 'fired', 'session_1');
    await expect(repo().findLocking('storify', 'pm', '2026-10-01T11:45:00.000Z')).resolves.toMatchObject({
      state: 'fired',
      sessionId: 'session_1',
    });
    const refused = await repo().claim(
      'storify',
      'qa',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T11:45:00.000Z',
    );
    await repo().release(refused ?? 0);
    await expect(repo().findLocking('storify', 'qa', '2026-10-01T11:45:00.000Z')).resolves.toBeNull();
    await repo().prune('2026-10-02T13:00:00.000Z');
    await expect(repo().findLocking('storify', 'pm', '2026-01-01T00:00:00.000Z')).resolves.toBeNull();
  });
});
