import { env } from 'cloudflare:test';
import { OwnerRequestsRepo } from './owner-requests.repo';

const repo = (): OwnerRequestsRepo => new OwnerRequestsRepo(env.DB);

function request(commentId: number, issueNumber: number, requestedAt: string, slug = 'tc') {
  return {
    commentId,
    slug,
    issueNumber,
    kind: 'sprint' as const,
    payload: '{"kind":"sprint","target":"next","v":1}',
    url: `https://github.com/geeera/team-console/issues/${issueNumber}#issuecomment-${commentId}`,
    requestedAt,
  };
}

describe('OwnerRequestsRepo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM owner_requests').run();
  });

  it('records a request once and reads it back as pending', async () => {
    await repo().record(request(100, 7, '2026-10-06T10:00:00.000Z'));
    await repo().record(request(100, 7, '2026-10-06T10:00:00.000Z'));
    await expect(repo().latestFor('tc', 7)).resolves.toMatchObject({
      commentId: 100,
      result: null,
      handledAt: null,
    });
    await expect(repo().countPending('tc')).resolves.toBe(1);
  });

  it('the newest request on an issue replaces the older one', async () => {
    await repo().record(request(100, 7, '2026-10-06T10:00:00.000Z'));
    await repo().record(request(101, 7, '2026-10-06T11:00:00.000Z'));
    await repo().record(request(200, 8, '2026-10-06T09:00:00.000Z'));
    const latest = await repo().latestPerIssue('tc');
    expect([...latest.entries()].map(([n, row]) => [n, row.commentId]).sort()).toEqual([
      [7, 101],
      [8, 200],
    ]);
    await expect(repo().countPending('tc')).resolves.toBe(2);
  });

  it('marks a request handled only for the same project and issue, after it was requested', async () => {
    await repo().record(request(100, 7, '2026-10-06T10:00:00.000Z'));
    const mark = {
      slug: 'tc',
      issueNumber: 7,
      commentId: 100,
      handledCommentId: 900,
      result: 'applied' as const,
      handledAt: '2026-10-06T12:00:00Z',
    };
    await expect(repo().markHandled({ ...mark, issueNumber: 8 })).resolves.toBe(false);
    await expect(repo().markHandled({ ...mark, slug: 'other' })).resolves.toBe(false);
    await expect(repo().markHandled({ ...mark, handledAt: '2026-10-06T09:59:59Z' })).resolves.toBe(false);
    await expect(repo().markHandled({ ...mark, handledAt: 'nonsense' })).resolves.toBe(false);
    await expect(repo().markHandled(mark)).resolves.toBe(true);
    await expect(repo().latestFor('tc', 7)).resolves.toMatchObject({
      result: 'applied',
      handledCommentId: 900,
      handledAt: '2026-10-06T12:00:00.000Z',
    });
    await expect(repo().countPending('tc')).resolves.toBe(0);
  });

  it('a later marker wins, an earlier one does not overwrite it', async () => {
    await repo().record(request(100, 7, '2026-10-06T10:00:00.000Z'));
    const mark = {
      slug: 'tc',
      issueNumber: 7,
      commentId: 100,
      handledCommentId: 900,
      result: 'declined' as const,
      handledAt: '2026-10-06T12:00:00Z',
    };
    await repo().markHandled(mark);
    await expect(
      repo().markHandled({
        ...mark,
        handledCommentId: 899,
        result: 'applied',
        handledAt: '2026-10-06T11:00:00Z',
      }),
    ).resolves.toBe(false);
    await expect(repo().latestFor('tc', 7)).resolves.toMatchObject({ result: 'declined' });
  });
});
