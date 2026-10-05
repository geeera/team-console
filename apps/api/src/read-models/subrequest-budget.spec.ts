import { GitHubError, parseRepoName } from '@worker/github';
import { ApiGitHub } from '../github';
import { json, localEnv, stubGitHub } from '../testing/github-kit';
import { SubrequestBudget } from './subrequest-budget';

const REPO = parseRepoName('geeera/alpha');

async function budgetProblem(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      return error.problem.type;
    }
    throw error;
  }
  throw new Error('expected a GitHubError');
}

describe('SubrequestBudget', () => {
  it('counts every call of its transport and refuses the one past the limit without sending it', async () => {
    const stub = stubGitHub(() => json(200, {}));
    const budget = new SubrequestBudget(2);
    const fetch = budget.transport(stub.fetch);

    await fetch('https://api.github.com/a', {});
    await fetch('https://api.github.com/b', {});
    expect(await budgetProblem(fetch('https://api.github.com/c', {}))).toBe('github-request-budget');
    expect(stub.calls).toHaveLength(2);
    expect(budget.spent).toBe(2);
  });

  it('counts a mint as two before minting, and nothing once the token is cached', async () => {
    const stub = stubGitHub(() => json(200, []));
    const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());
    const budget = new SubrequestBudget(10);

    await budget.connectionFor(connection, REPO);
    expect(budget.spent).toBe(2);
    expect(stub.calls).toHaveLength(2);

    await budget.connectionFor(connection, REPO);
    expect(budget.spent).toBe(2);
  });

  it('does not mint when the mint would pass the limit', async () => {
    const stub = stubGitHub(() => json(200, []));
    const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());

    expect(await budgetProblem(new SubrequestBudget(1).connectionFor(connection, REPO))).toBe(
      'github-request-budget',
    );
    expect(stub.calls).toHaveLength(0);
  });
});
