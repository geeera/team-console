import { env } from 'cloudflare:test';
import { handledMarker } from '@shared/owner-grammar';
import { issueCommentEvent } from '../testing/payloads';
import { RecordingPushSender, deliver, resetDatabase, seedProject } from '../testing/webhook-kit';

// #219 (ADR 0005 decision 3): the PM's handled marker on `issue_comment.created` marks the owner's request, only
// when every rule holds; anything else changes nothing and is handled like any other comment.

const REQUEST_ID = 7_000_001;
const TEAM = { login: 'team-console-team[bot]', type: 'Bot' } as const;
const MARK = handledMarker({ commentId: REQUEST_ID, result: 'applied' });

async function seedRequest(issueNumber = 42, slug = 'storify'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO owner_requests (comment_id, slug, issue_number, kind, payload, url, requested_at)
     VALUES (?1, ?2, ?3, 'sprint', '{"kind":"sprint","target":"next","v":1}', 'https://github.com/x', '2026-10-06T10:00:00.000Z')`,
  )
    .bind(REQUEST_ID, slug, issueNumber)
    .run();
}

async function resultOf(): Promise<string | null> {
  const row = await env.DB.prepare('SELECT result FROM owner_requests WHERE comment_id = ?1')
    .bind(REQUEST_ID)
    .first<{ result: string | null }>();
  return row?.result ?? null;
}

beforeEach(async () => {
  await resetDatabase();
  await seedProject('storify', 'geeera/storify', { displayName: 'Storify' });
  await seedRequest();
});

describe('POST /hooks/github — owner request handled markers', () => {
  it("marks the request when the team's app posts the marker after it; no push", async () => {
    const sender = new RecordingPushSender();
    const { response } = await deliver(
      issueCommentEvent({
        body: `${MARK}\n**PM note**: done.`,
        commentAuthor: TEAM,
        commentAssociation: 'NONE',
      }),
      { event: 'issue_comment', pushSender: sender },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'request-handled' });
    expect(await resultOf()).toBe('applied');
    expect(sender.messages).toEqual([]);
  });

  it.each([
    [
      'a collaborator',
      {
        commentAuthor: { login: 'helper', type: 'User' as const },
        commentAssociation: 'COLLABORATOR' as const,
      },
    ],
    ['the owner', { commentAuthor: { login: 'geeera', type: 'User' as const } }],
    [
      'a user named like the bot',
      { commentAuthor: { login: 'team-console-team[bot]', type: 'User' as const } },
    ],
    ['a quoted marker in prose', { commentAuthor: TEAM, body: `The PM wrote ${MARK}` }],
    [
      'malformed JSON',
      { commentAuthor: TEAM, body: '<!-- pt-owner-request-handled {"comment_id":7000001} -->' },
    ],
    ['a marker on another issue', { commentAuthor: TEAM, number: 43 }],
    ['a marker from before the request', { commentAuthor: TEAM, createdAt: '2026-10-06T09:00:00Z' }],
    ['an edit of a comment', { commentAuthor: TEAM, action: 'edited' as const }],
  ])('ignores %s', async (_, options) => {
    await deliver(issueCommentEvent({ body: MARK, ...options }), { event: 'issue_comment' });
    expect(await resultOf()).toBeNull();
  });

  it('ignores a marker for a request of another project', async () => {
    await env.DB.prepare('DELETE FROM owner_requests').run();
    await seedProject('other', 'geeera/other', { displayName: 'Other' });
    await seedRequest(42, 'other');
    await deliver(issueCommentEvent({ body: MARK, commentAuthor: TEAM }), { event: 'issue_comment' });
    expect(await resultOf()).toBeNull();
  });
});
