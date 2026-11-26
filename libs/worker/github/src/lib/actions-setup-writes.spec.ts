import { actionsSetupBranchOf } from '@shared/actions-workflow';
import {
  closeSetupPull,
  createSetupBranch,
  openSetupPull,
  putRunnerWorkflow,
  readSetupBlobSha,
  type CreatedSetupBranch,
} from './actions-setup-writes';
import { judgePullProvenance, readActionsSetupPull, RUNNER_WORKFLOW_PATH } from './actions-setup-pull';
import { GitHubAppAuth } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { createMockGitHub, MOCK_FIXTURES, type MockGitHub } from './mock';
import { parseRepoName } from './repo-name';
import type { ScopedInstallationToken, ScopedMintAudit } from './scoped-mint';
import type { FetchLike } from './transport';

// #759 PR 4: the setup's writes against the mock GitHub, which remembers them and trips on any write outside a
// branch it created (security note row "The console writes outside its own branch").

const TEAM_CONSOLE = {
  installation: 1001,
  id: 900001,
  repo: parseRepoName('geeera/team-console'),
  defaultBranch: 'dev',
};
const noAudit: ScopedMintAudit = async () => undefined;
const TEXT = 'name: team-console-runner\n';
const BRANCH = actionsSetupBranchOf('ab'.repeat(32));

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

interface World {
  readonly mock: MockGitHub;
  readonly auth: GitHubAppAuth;
  readonly fetch: FetchLike;
  readonly calls: Recorded[];
  readonly token: ScopedInstallationToken<'workflow-pr'>;
}

async function world(): Promise<World> {
  const mock = await createMockGitHub();
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      method: init.method ?? 'GET',
      path: new URL(input).pathname,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return mock.fetch(input, init);
  };
  const auth = new GitHubAppAuth(mock.credentials, { fetch, setupWrite: 'enabled' });
  const token = await auth.mintScoped(
    'workflow-pr',
    { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id },
    noAudit,
  );
  calls.length = 0;
  return { mock, auth, fetch, calls, token };
}

async function created(w: World, branch = BRANCH): Promise<CreatedSetupBranch> {
  const outcome = await createSetupBranch(w.fetch, w.token, TEAM_CONSOLE.repo, {
    branch,
    defaultBranch: TEAM_CONSOLE.defaultBranch,
  });
  if (outcome.kind !== 'created') {
    throw new Error('the branch was not created');
  }
  return outcome.branch;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('createSetupBranch', () => {
  it('creates the branch at the default branch’s head with one POST …/git/refs', async () => {
    const w = await world();
    const branch = await created(w);
    expect(branch).toMatchObject({ branch: BRANCH, base: 'dev', repositoryId: TEAM_CONSOLE.id });
    expect(w.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/geeera/team-console/branches/dev',
      'POST /repos/geeera/team-console/git/refs',
    ]);
    expect(w.calls[1]?.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: branch.baseSha });
  });

  it('leaves a branch that already exists alone: `exists`, and nothing else is sent', async () => {
    const w = await world();
    await created(w);
    w.calls.length = 0;
    const again = await createSetupBranch(w.fetch, w.token, TEAM_CONSOLE.repo, {
      branch: BRANCH,
      defaultBranch: 'dev',
    });
    expect(again).toEqual({ kind: 'exists' });
    expect(w.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  });

  it.each([
    ['the default branch', 'dev'],
    ['a name without the console’s prefix', 'feature/runner-0123456789ab'],
    ['a prefix with something other than 12 hex characters', 'team-console/runner-main'],
    ['a longer name under the prefix', 'team-console/runner-0123456789ab/x'],
  ])('refuses %s before any request', async (_case, branch) => {
    const w = await world();
    const error = await rejection(
      createSetupBranch(w.fetch, w.token, TEAM_CONSOLE.repo, { branch, defaultBranch: 'dev' }),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect(w.calls).toEqual([]);
  });

  it('takes a workflow-pr token only', async () => {
    const w = await world();
    const other = await w.auth.mintScoped(
      'actions-dispatch',
      { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id },
      noAudit,
    );
    w.calls.length = 0;
    const error = await rejection(
      createSetupBranch(
        w.fetch,
        other as unknown as ScopedInstallationToken<'workflow-pr'>,
        TEAM_CONSOLE.repo,
        { branch: BRANCH, defaultBranch: 'dev' },
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(w.calls).toEqual([]);
  });
});

describe('putRunnerWorkflow and readSetupBlobSha', () => {
  it('commits the one workflow file to the created branch, naming the branch in the body', async () => {
    const w = await world();
    const branch = await created(w);
    expect(await readSetupBlobSha(w.fetch, w.token, TEAM_CONSOLE.repo, branch)).toBeNull();
    w.calls.length = 0;
    const commit = await putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      text: TEXT,
      message: 'Add',
      blobSha: null,
    });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.method).toBe('PUT');
    expect(w.calls[0]?.path).toBe(`/repos/geeera/team-console/contents/${RUNNER_WORKFLOW_PATH}`);
    expect(w.calls[0]?.body).toEqual({ message: 'Add', content: btoa(TEXT), branch: BRANCH });
  });

  it('replaces a file only with the sha of the blob the branch holds (compare-and-set)', async () => {
    const w = await world();
    const branch = await created(w);
    await putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      text: TEXT,
      message: 'Add',
      blobSha: null,
    });
    const sha = await readSetupBlobSha(w.fetch, w.token, TEAM_CONSOLE.repo, branch);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const stale = await rejection(
      putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
        text: 'other\n',
        message: 'Update',
        blobSha: 'a'.repeat(40),
      }),
    );
    expect(stale).toBeInstanceOf(GitHubError);
    expect((stale as GitHubError).githubStatus).toBe(409);
    await putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      text: 'other\n',
      message: 'Update',
      blobSha: sha,
    });
  });

  it.each([
    ['a hand-built branch object', (branch: CreatedSetupBranch): CreatedSetupBranch => ({ ...branch })],
    [
      'the default branch dressed up as one',
      (branch: CreatedSetupBranch): CreatedSetupBranch => ({ ...branch, branch: 'dev' }),
    ],
  ])(
    'refuses %s before any request: only the object createSetupBranch returned is a target',
    async (_case, forge) => {
      const w = await world();
      const forged = forge(await created(w));
      w.calls.length = 0;
      for (const attempt of [
        putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, forged, {
          text: TEXT,
          message: 'Add',
          blobSha: null,
        }),
        readSetupBlobSha(w.fetch, w.token, TEAM_CONSOLE.repo, forged),
        openSetupPull(w.fetch, w.token, TEAM_CONSOLE.repo, forged, { title: 't', body: 'b' }),
      ]) {
        expect(await rejection(attempt)).toBeInstanceOf(TypeError);
      }
      expect(w.calls).toEqual([]);
    },
  );
});

describe('openSetupPull and closeSetupPull', () => {
  it('opens the PR from the created branch into the default branch, and the readers then see the console’s PR', async () => {
    const w = await world();
    const branch = await created(w);
    const commit = await putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      text: TEXT,
      message: 'Add',
      blobSha: null,
    });
    w.calls.length = 0;
    const pull = await openSetupPull(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      title: 'Add the workflow',
      body: 'Body',
    });
    expect(pull.headSha).toBe(commit);
    expect(pull.htmlUrl).toBe(`https://github.com/geeera/team-console/pull/${String(pull.number)}`);
    expect(w.calls[0]?.body).toEqual({
      title: 'Add the workflow',
      body: 'Body',
      head: BRANCH,
      base: 'dev',
      maintainer_can_modify: false,
    });

    const client = new GitHubClient(w.fetch, w.auth.tokenSourceFor(TEAM_CONSOLE.repo));
    const read = await readActionsSetupPull(client, TEAM_CONSOLE.repo, BRANCH);
    expect(read?.number).toBe(pull.number);
    expect(
      read === null
        ? null
        : judgePullProvenance(read, {
            repositoryId: TEAM_CONSOLE.id,
            botLogin: 'team-console-local[bot]',
            rendering: new TextEncoder().encode(TEXT),
          }),
    ).toBe('console');
  });

  it('closes a PR it opened; the branch stays', async () => {
    const w = await world();
    const branch = await created(w);
    await putRunnerWorkflow(w.fetch, w.token, TEAM_CONSOLE.repo, branch, {
      text: TEXT,
      message: 'Add',
      blobSha: null,
    });
    const pull = await openSetupPull(w.fetch, w.token, TEAM_CONSOLE.repo, branch, { title: 't', body: 'b' });
    w.calls.length = 0;
    await closeSetupPull(w.fetch, w.token, TEAM_CONSOLE.repo, pull.number);
    expect(w.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `PATCH /repos/geeera/team-console/pulls/${String(pull.number)}`,
    ]);
    expect(w.calls[0]?.body).toEqual({ state: 'closed' });
    const client = new GitHubClient(w.fetch, w.auth.tokenSourceFor(TEAM_CONSOLE.repo));
    expect(await readActionsSetupPull(client, TEAM_CONSOLE.repo, BRANCH)).toBeNull();
    expect(
      await createSetupBranch(w.fetch, w.token, TEAM_CONSOLE.repo, { branch: BRANCH, defaultBranch: 'dev' }),
    ).toEqual({ kind: 'exists' });
  });
});

describe('the mock’s tripwires for the setup writes', () => {
  async function raw(w: World, method: string, path: string, body?: unknown): Promise<Response> {
    return w.mock.fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${w.token.bearer()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const contents = `/repos/geeera/team-console/contents/${RUNNER_WORKFLOW_PATH}`;

  it('trips on a contents write that names no branch, the default branch or a branch it did not create', async () => {
    const w = await world();
    await created(w);
    for (const branch of [undefined, 'dev', 'feature/x']) {
      const response = await raw(w, 'PUT', contents, {
        message: 'm',
        content: btoa(TEXT),
        ...(branch === undefined ? {} : { branch }),
      });
      expect(response.status, String(branch)).toBe(403);
    }
  });

  it('trips on a PATCH or DELETE of a ref, and on any other call of the token', async () => {
    const w = await world();
    await created(w);
    expect(
      (
        await raw(w, 'PATCH', `/repos/geeera/team-console/git/refs/heads/${BRANCH}`, {
          sha: 'a'.repeat(40),
          force: true,
        })
      ).status,
    ).toBe(403);
    expect((await raw(w, 'DELETE', `/repos/geeera/team-console/git/refs/heads/${BRANCH}`)).status).toBe(403);
    expect((await raw(w, 'PUT', `/repos/geeera/team-console/pulls/1/merge`)).status).toBe(403);
    expect((await raw(w, 'GET', '/repos/geeera/team-console/issues')).status).toBe(403);
  });

  it('answers another repository 404, and a repository that has not accepted the writes no token at all', async () => {
    const w = await world();
    expect(
      (
        await raw(w, 'POST', '/repos/geeera/private-product/git/refs', {
          ref: `refs/heads/${BRANCH}`,
          sha: 'a'.repeat(40),
        })
      ).status,
    ).toBe(404);
    const privateProduct = MOCK_FIXTURES.repositories['geeera/private-product']?.repository?.['id'];
    const error = await rejection(
      w.auth.mintScoped(
        'workflow-pr',
        { installationId: TEAM_CONSOLE.installation, repositoryId: Number(privateProduct) },
        noAudit,
      ),
    );
    expect((error as GitHubError).githubStatus).toBe(422);
  });

  it('a token of another kind, or the read token, writes nothing', async () => {
    const w = await world();
    const dispatch = await w.auth.mintScoped(
      'actions-dispatch',
      { installationId: TEAM_CONSOLE.installation, repositoryId: TEAM_CONSOLE.id },
      noAudit,
    );
    const response = await w.mock.fetch(`https://api.github.com${contents}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${dispatch.bearer()}` },
      body: JSON.stringify({ message: 'm', content: btoa(TEXT), branch: BRANCH }),
    });
    expect(response.ok).toBe(false);
  });
});
