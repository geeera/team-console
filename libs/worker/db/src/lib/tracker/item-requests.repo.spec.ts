import { env } from 'cloudflare:test';
import { AT, JOB_ACTOR, OWNER_ACTOR, seedTrackerItem, seedTrackerProject } from '../../testing/tracker-kit';
import { IdempotencyKeysRepo } from './idempotency-keys.repo';
import { ItemEventsRepo } from './item-events.repo';
import { ItemRequestsRepo } from './item-requests.repo';

const requests = (): ItemRequestsRepo => new ItemRequestsRepo(env.DB);

async function seed(): Promise<{ slug: string; itemId: number }> {
  const { slug } = await seedTrackerProject();
  return { slug, itemId: await seedTrackerItem(slug, 1, { kind: 'feature', status: 'approved' }) };
}

describe('ItemRequestsRepo', () => {
  it('stores the canonical payload, a requested event, and the newest request is the pending one', async () => {
    const { slug, itemId } = await seed();
    const keys = new IdempotencyKeysRepo(env.DB);
    const now = Date.parse(AT);
    await keys.claim('key-request-1', 'hash', now, 30_000);
    const first = await requests().create(slug, itemId, { kind: 'sprint', target: 'next' }, OWNER_ACTOR, AT, [
      keys.completeStatement(
        'key-request-1',
        'hash',
        { status: 201, kind: 'request', ref: { newestRequestOf: itemId } },
        now + 1,
      ),
    ]);
    const second = await requests().create(
      slug,
      itemId,
      { kind: 'priority', direction: 'up' },
      OWNER_ACTOR,
      AT,
    );
    const payload = await env.DB.prepare('SELECT payload FROM item_requests WHERE id = ?1')
      .bind(first)
      .first<{ payload: string }>();
    expect(payload?.payload).toBe('{"kind":"sprint","target":"next","v":1}');
    expect(await requests().newest(itemId)).toMatchObject({
      id: second,
      request: { kind: 'priority', direction: 'up' },
      result: null,
    });
    expect((await requests().list(itemId, 0, 10)).map((row) => row.id)).toEqual([first, second]);
    expect(await keys.claim('key-request-1', 'hash', now, 30_000)).toMatchObject({ ref: String(first) });
    const events = await new ItemEventsRepo(env.DB).list(itemId, 0, 10);
    expect(events.filter((event) => event.kind === 'requested').map((event) => event.after)).toEqual([
      { requestId: first, request: { kind: 'sprint', target: 'next' } },
      { requestId: second, request: { kind: 'priority', direction: 'up' } },
    ]);
  });

  it('finds a request only in its own project', async () => {
    const { slug, itemId } = await seed();
    const id = await requests().create(slug, itemId, { kind: 'sprint', target: 'backlog' }, OWNER_ACTOR, AT);
    const { slug: other } = await seedTrackerProject();
    expect(await requests().find(slug, id)).toMatchObject({ id });
    expect(await requests().find(other, id)).toBeNull();
  });

  it('marks a request handled once, with a handled event; the second answer is false and writes nothing', async () => {
    const { slug, itemId } = await seed();
    const id = await requests().create(slug, itemId, { kind: 'sprint', target: 'next' }, OWNER_ACTOR, AT);
    const handling = { jobId: 'job-test-1', result: 'declined', reason: 'Freeze' } as const;
    expect(await requests().markHandled({ id, itemId }, handling, JOB_ACTOR, AT)).toBe(true);
    expect(
      await requests().markHandled({ id, itemId }, { ...handling, result: 'applied' }, JOB_ACTOR, AT),
    ).toBe(false);
    expect(await requests().find(slug, id)).toMatchObject({
      handledByJobId: 'job-test-1',
      result: 'declined',
      reason: 'Freeze',
      handledAt: AT,
    });
    const events = await new ItemEventsRepo(env.DB).list(itemId, 0, 10);
    expect(
      events.filter((event) => event.kind === 'handled').map((event) => [event.actorKind, event.after]),
    ).toEqual([['job', { requestId: id, result: 'declined' }]]);
  });

  it('is append-only and keeps the handled columns together', async () => {
    const { slug, itemId } = await seed();
    const id = await requests().create(slug, itemId, { kind: 'sprint', target: 'next' }, OWNER_ACTOR, AT);
    await expect(
      env.DB.prepare(
        `UPDATE item_requests SET payload = '{"kind":"sprint","target":"current","v":1}' WHERE id = ?1`,
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM item_requests WHERE id = ?1').bind(id).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO item_requests (id, project_slug, item_id, kind, payload, requested_at)
         VALUES (?1, ?2, ?3, 'priority', '{"direction":"up","kind":"priority","v":1}', ?4)`,
      )
        .bind(id, slug, itemId, AT)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE item_requests SET result = 'applied' WHERE id = ?1").bind(id).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        `INSERT INTO item_requests (project_slug, item_id, kind, payload, requested_at)
         VALUES (?1, ?2, 'sprint', '{"direction":"up","kind":"priority","v":1}', ?3)`,
      )
        .bind(slug, itemId, AT)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('reads a payload it does not know as no request at all', async () => {
    const { slug, itemId } = await seed();
    await env.DB.prepare(
      `INSERT INTO item_requests (project_slug, item_id, kind, payload, requested_at)
       VALUES (?1, ?2, 'sprint', '{"kind":"sprint","target":"next","v":2}', ?3)`,
    )
      .bind(slug, itemId, AT)
      .run();
    expect(await requests().newest(itemId)).toMatchObject({ kind: 'sprint', request: null });
  });
});
