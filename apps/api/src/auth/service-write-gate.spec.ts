import { parseRepoName } from '@worker/github';
import { FIXTURE_LABEL, serviceWriteRefusal, type GatedIssue } from './service-write-gate';

// #62: which issues the Access service identity may write on as the owner. The route wiring is in answer.spec.ts.

const REPO = parseRepoName('geeera/team-console');
const BY_OWNER = { authorLogin: 'geeera', authorType: 'User' } as const;
const BY_TEAM = { authorLogin: 'team-console-team[bot]', authorType: 'Bot' } as const;

function issue(labels: readonly string[], author: Pick<GatedIssue, 'authorLogin' | 'authorType'> = BY_OWNER) {
  return { labels, ...author };
}

describe('serviceWriteRefusal', () => {
  it('uses the e2e:fixture label', () => {
    expect(FIXTURE_LABEL).toBe('e2e:fixture');
  });

  it('refuses an issue without the fixture label', () => {
    expect(serviceWriteRefusal(issue(['needs:owner', 'kind:chore']), REPO)).toEqual({
      type: 'service-not-fixture',
      reason: 'no-fixture-label',
    });
  });

  it('refuses a label that only looks like the fixture label', () => {
    for (const label of ['E2E:fixture', 'e2e:fixture ', 'e2e:fixtures', 'e2e']) {
      expect(serviceWriteRefusal(issue(['needs:owner', label]), REPO)?.type).toBe('service-not-fixture');
    }
  });

  it.each([
    [['needs:owner', FIXTURE_LABEL], BY_OWNER],
    [['needs:owner', FIXTURE_LABEL], BY_TEAM],
    [['needs:local', FIXTURE_LABEL], BY_TEAM],
    [['kind:question', FIXTURE_LABEL], BY_OWNER],
    [['kind:question', FIXTURE_LABEL], { authorLogin: 'GEEERA', authorType: 'User' }],
  ] as const)('allows a fixture issue %j opened by %j', (labels, author) => {
    expect(serviceWriteRefusal(issue(labels, author), REPO)).toBeNull();
  });

  it.each([
    [['team:demo', FIXTURE_LABEL], 'release'],
    [['team:demo', 'needs:owner', FIXTURE_LABEL], 'release'],
    [['design:awaiting-approval', FIXTURE_LABEL], 'design'],
    [['design:approved', 'kind:question', FIXTURE_LABEL], 'design'],
    [['design:anything-new', FIXTURE_LABEL], 'design'],
  ] as const)('refuses %j even with the fixture label (%s)', (labels, reason) => {
    expect(serviceWriteRefusal(issue(labels), REPO)).toEqual({ type: 'service-protected-item', reason });
  });

  it.each([
    ['the team bot', BY_TEAM],
    ['an outsider', { authorLogin: 'outsider', authorType: 'User' }],
    ['a bot named like the owner', { authorLogin: 'geeera', authorType: 'Bot' }],
    ['a deleted account', { authorLogin: null, authorType: null }],
  ] as const)('refuses a fixture question opened by %s', (_who, author) => {
    expect(serviceWriteRefusal(issue(['kind:question', FIXTURE_LABEL], author), REPO)).toEqual({
      type: 'service-protected-item',
      reason: 'team-question',
    });
  });

  it('names the protection, not the missing label, on a protected issue without the fixture label', () => {
    expect(serviceWriteRefusal(issue(['team:demo']), REPO)?.type).toBe('service-protected-item');
  });
});
