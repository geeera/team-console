import { handledMarker, requestMarker } from '@shared/owner-grammar';
import { handledRequestOf, type HandledCandidate } from './request-handled';

const AT = '2026-10-06T12:00:00Z';
const MARK = handledMarker({ commentId: 100, result: 'applied' });
const TEAM: HandledCandidate = {
  id: 900,
  body: `${MARK}\n**PM note**: your request is applied.`,
  authorLogin: 'team-console-team[bot]',
  authorType: 'Bot',
  createdAt: AT,
  updatedAt: AT,
};

describe('handledRequestOf (ADR 0005 decision 3)', () => {
  it("reads the team app's unedited marker", () => {
    expect(handledRequestOf(TEAM, true)).toEqual({
      commentId: 100,
      handledCommentId: 900,
      result: 'applied',
      handledAt: AT,
    });
  });

  it.each<[string, Partial<HandledCandidate>]>([
    ['a collaborator', { authorLogin: 'collaborator', authorType: 'User' }],
    ['the owner', { authorLogin: 'geeera', authorType: 'User' }],
    ['a user named like the bot', { authorType: 'User' }],
    ['another bot', { authorLogin: 'dependabot[bot]' }],
    ['a quoted marker in prose', { body: `As the PM wrote: ${MARK}` }],
    ['a marker on the second line', { body: `Note\n${MARK}` }],
    ['malformed JSON', { body: '<!-- pt-owner-request-handled {"comment_id":100,"result":"applied"} -->' }],
    ['a request marker', { body: requestMarker({ kind: 'sprint', target: 'next' }) }],
    ['no creation time', { createdAt: null }],
  ])('ignores %s', (_, change) => {
    expect(handledRequestOf({ ...TEAM, ...change }, false)).toBeNull();
  });

  it('ignores an edited marker on the re-read, but a webhook created delivery has no edit to check', () => {
    const edited = { ...TEAM, updatedAt: '2026-10-06T12:05:00Z' };
    expect(handledRequestOf(edited, true)).toBeNull();
    expect(handledRequestOf({ ...TEAM, updatedAt: null }, false)).not.toBeNull();
  });
});
