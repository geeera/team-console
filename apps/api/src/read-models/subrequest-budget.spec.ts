import { GitHubError, parseRepoName } from '@worker/github';
import { ApiGitHub } from '../github';
import { INSTALLATION_ID, json, localEnv, stubGitHub } from '../testing/github-kit';
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

  describe('listConnectionFor (#194)', () => {
    const OWNER_ID = 100001;
    const installations = () =>
      stubGitHub((call) =>
        call.url.pathname === '/app/installations'
          ? json(200, [{ id: INSTALLATION_ID, account: { id: OWNER_ID } }])
          : json(404, {}),
      );

    it('spends 2 on a cold list token (lookup and mint), 1 once it is cached (the lookup)', async () => {
      const stub = installations();
      const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());
      const budget = new SubrequestBudget(10);

      const first = await budget.listConnectionFor(connection, OWNER_ID);
      expect(first.installationId).toBe(INSTALLATION_ID);
      expect(first.source.kind).toBe('installation-list');
      expect(budget.spent).toBe(2);
      expect(stub.calls).toHaveLength(2);

      await budget.listConnectionFor(connection, OWNER_ID);
      expect(budget.spent).toBe(3);
      expect(stub.minted()).toBe(1);
    });

    it('asks GitHub nothing when even the lookup would pass the limit', async () => {
      const stub = installations();
      const connection = await new ApiGitHub({ fetch: stub.fetch }).connect(localEnv());
      expect(await budgetProblem(new SubrequestBudget(0).listConnectionFor(connection, OWNER_ID))).toBe(
        'github-request-budget',
      );
      expect(stub.calls).toHaveLength(0);
    });
  });
});
