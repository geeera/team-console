import { isSprintCiState } from '@shared/contracts';
import checkRuns from '../../fixtures/check-runs.json';
import { checkRunsPageOf, ciStateOf, isGitHubCheckRunsPage } from './ci-state';

// #131: the CI state from GitHub's check-runs answers in fixtures/check-runs.json, one case per state and the mixes.

interface Case {
  readonly name: string;
  readonly expected: string;
  readonly answer: unknown;
}

const cases: readonly Case[] = checkRuns.cases;

function stateOf(answer: unknown): string {
  if (!isGitHubCheckRunsPage(answer)) {
    throw new Error('fixture answer of an unexpected shape');
  }
  return ciStateOf(checkRunsPageOf(answer));
}

describe('ciStateOf (fixtures)', () => {
  it.each(cases.map((fixture) => [fixture.name, fixture.expected, fixture.answer] as const))(
    '%s → %s',
    (_name, expected, answer) => {
      expect(stateOf(answer)).toBe(expected);
    },
  );

  it('covers every state the board shows', () => {
    const covered = new Set(cases.map((fixture) => fixture.expected));
    expect([...covered].every(isSprintCiState)).toBe(true);
    expect(covered).toEqual(new Set(['success', 'failure', 'pending', 'none', 'unknown']));
  });
});

describe('isGitHubCheckRunsPage', () => {
  it.each([
    ['a list instead of the wrapper', []],
    ['no count', { check_runs: [] }],
    ['a negative count', { total_count: -1, check_runs: [] }],
    ['a run without a status', { total_count: 1, check_runs: [{ conclusion: 'success' }] }],
    ['a numeric conclusion', { total_count: 1, check_runs: [{ status: 'completed', conclusion: 1 }] }],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(isGitHubCheckRunsPage(value)).toBe(false);
  });
});

describe('ciStateOf', () => {
  it('reads a completed run without a conclusion as passed, as the plugin does', () => {
    expect(ciStateOf({ totalCount: 1, runs: [{ status: 'completed', conclusion: null }] })).toBe('success');
  });

  it('is unknown when GitHub counts runs it did not list', () => {
    expect(ciStateOf({ totalCount: 3, runs: [] })).toBe('unknown');
  });

  it('keeps a failure on the first page even when more runs are unseen', () => {
    expect(ciStateOf({ totalCount: 150, runs: [{ status: 'completed', conclusion: 'failure' }] })).toBe(
      'failure',
    );
  });
});
