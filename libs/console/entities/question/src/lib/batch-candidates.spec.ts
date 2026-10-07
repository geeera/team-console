import { batchCandidatesOf } from './batch-candidates';
import type { QuestionItem } from './question.model';

function item(number: number, overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug: 'tc', name: 'Team Console' },
    section: 'question',
    number,
    title: `Question ${number}`,
    url: null,
    ask: '/approve (recommended) · /reject why',
    body: null,
    authorTrusted: true,
    allowedCommands: ['approve', 'reject'],
    category: 'scope',
    recommendation: 'approve',
    ...overrides,
  };
}

describe('batchCandidatesOf', () => {
  it('lists exactly the trusted scope questions the team recommends approving, in order', () => {
    const { candidates } = batchCandidatesOf([
      item(3),
      item(1, { category: 'money' }),
      item(2),
      item(4, { recommendation: null }),
    ]);
    expect(candidates.map((candidate) => candidate.number)).toEqual([3, 2]);
  });

  it('lists the rest separately with the reason', () => {
    const { leftOut } = batchCandidatesOf([
      item(1, { category: 'money' }),
      item(2, { category: 'release' }),
      item(3, { category: 'legal' }),
      item(4, { category: 'access' }),
      item(5, { category: 'design' }),
      item(6, { section: 'design', category: null }),
      item(7, { section: 'release', category: null, recommendation: 'go' }),
      item(8, { recommendation: 'reject' }),
      item(9, { recommendation: null }),
      item(10, { authorTrusted: false }),
      item(11, { category: null }),
    ]);
    expect(leftOut.map(({ item: left, reason }) => [left.number, reason])).toEqual([
      [1, 'money'],
      [2, 'release'],
      [3, 'legal'],
      [4, 'access'],
      [5, 'design'],
      [6, 'design'],
      [7, 'release'],
      [8, 'reject'],
      [9, 'no-recommendation'],
      [10, 'untrusted'],
      [11, 'uncategorised'],
    ]);
  });

  it('keeps action items out of both lists', () => {
    const result = batchCandidatesOf([
      item(1, { section: 'owner', category: null, recommendation: null }),
      item(2, { section: 'local', category: null, recommendation: null }),
    ]);
    expect(result).toEqual({ candidates: [], leftOut: [] });
  });

  it('is empty for an empty list', () => {
    expect(batchCandidatesOf([])).toEqual({ candidates: [], leftOut: [] });
  });
});
