import type { BatchFacts } from './batch';
import { batchVerdictOf, categoryOf, recommendationOf } from './batch';

describe('categoryOf', () => {
  it.each([
    [['kind:question', 'owner:scope'], 'scope'],
    [['owner:money', 'kind:question'], 'money'],
    [['owner:design'], 'design'],
    [['kind:question'], null],
    [['owner:unknown', 'owner:'], null],
    [[], null],
  ] as const)('%j → %s', (labels, expected) => {
    expect(categoryOf(labels)).toBe(expected);
  });

  it('lets any other category win over scope when someone added two by hand', () => {
    expect(categoryOf(['owner:scope', 'owner:legal'])).toBe('legal');
    expect(categoryOf(['owner:access', 'owner:scope'])).toBe('access');
  });
});

describe('recommendationOf', () => {
  it.each([
    ['/approve to use R2 (recommended) · /reject why to keep SeaweedFS', 'approve'],
    ['`/approve` to use Cloudflare R2 (free, recommended) · `/reject why`', 'approve'],
    ['/approve — начинаем разработку (рекомендую) · /reject что поменять', 'approve'],
    ['/reject why to keep it (RECOMMENDED) · /approve to drop it', 'reject'],
    ['/go to release 1.2.0 (recommended) · /no-go why', 'go'],
    ['/no-go — рано (Рекомендуем) · /go', 'no-go'],
    ['We recommend: /approve the plan', 'approve'],
  ] as const)('%s → %s', (ask, expected) => {
    expect(recommendationOf(ask)).toBe(expected);
  });

  it.each([
    ['/approve to use R2 · /reject why', 'no recommendation word'],
    ['recommended, but no command', 'no command'],
    ['see docs/approve (recommended)', 'a path is not a command'],
    ['/approved already (recommended)', 'a longer word is not a command'],
    ['/go-live (recommended)', 'a hyphenated word is not /go'],
    ['', 'an empty line'],
  ])('null for %s (%s)', (ask) => {
    expect(recommendationOf(ask)).toBeNull();
  });

  it('null without an answer line', () => {
    expect(recommendationOf(null)).toBeNull();
  });

  it('reads /no-go as no-go, never as /go', () => {
    expect(recommendationOf('/no-go (recommended)')).toBe('no-go');
  });
});

describe('batchVerdictOf', () => {
  const safe: BatchFacts = {
    section: 'question',
    category: 'scope',
    recommendation: 'approve',
    authorTrusted: true,
  };

  it('batches a trusted scope question the team recommends approving', () => {
    expect(batchVerdictOf(safe)).toEqual({ kind: 'batch' });
  });

  it.each([
    ['untrusted', { authorTrusted: false }],
    ['money', { category: 'money' }],
    ['release', { category: 'release' }],
    ['legal', { category: 'legal' }],
    ['access', { category: 'access' }],
    ['design', { category: 'design' }],
    ['release', { section: 'release', category: null }],
    ['design', { section: 'design', category: null, recommendation: null }],
    ['uncategorised', { category: null }],
    ['reject', { recommendation: 'reject' }],
    ['reject', { recommendation: 'no-go' }],
    ['no-recommendation', { recommendation: null }],
    ['no-recommendation', { recommendation: 'go' }],
  ] as const)('leaves it out as %s for %j', (reason, change) => {
    expect(batchVerdictOf({ ...safe, ...change })).toEqual({ kind: 'left-out', reason });
  });

  it('names an outsider first, whatever else the item says', () => {
    expect(batchVerdictOf({ ...safe, category: 'money', authorTrusted: false })).toEqual({
      kind: 'left-out',
      reason: 'untrusted',
    });
  });

  it.each(['owner', 'local'] as const)('does not list a %s action item at all', (section) => {
    expect(batchVerdictOf({ ...safe, section, authorTrusted: false })).toEqual({ kind: 'not-asked' });
  });
});
