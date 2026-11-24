import { installationToken } from '../testing/github-kit';
import {
  hasInferenceKeySecret,
  readActionsEnvironment,
  readDeploymentBranchPolicies,
  readRunnerWorkflowFile,
  RUNNER_WORKFLOW_MAX_BYTES,
} from './actions-setup-reads';
import { GitHubAppAuth } from './app-auth';
import { GitHubClient } from './client';
import { GitHubError } from './errors';
import { MOCK_FIXTURES, createMockGitHub, type MockFixtures, type MockGitHub } from './mock';
import { parseRepoName } from './repo-name';
import { ScopedInstallationToken, type ScopedMintAudit } from './scoped-mint';
import type { FetchLike } from './transport';

// #759: the readiness reads against the mock GitHub. Sentinels stand for what must never come out of them: a reviewer
// login, another secret's name and a variable's value of the same Environment.

const REVIEWER_SENTINEL = ['reviewer', 'SENTINEL', 'login'].join('-');
const OTHER_SECRET_SENTINEL = ['OTHER', 'SECRET', 'SENTINEL'].join('_');
const WORKFLOW_PATH = '.github/workflows/team-console-runner.yml';
const WORKFLOW_TEXT = "name: team-console-runner\non:\n  workflow_dispatch:\n# rendering — byte for byte\n";

const STRICT = { installationId: 2001, repositoryId: 910001, repo: 'acme/strict' };
const BARE = { installationId: 2001, repositoryId: 910002, repo: 'acme/bare' };
const BIG = { installationId: 2001, repositoryId: 910003, repo: 'acme/big' };

const repository = (id: number, fullName: string): Readonly<Record<string, unknown>> => ({
  id,
  full_name: fullName,
  private: true,
  default_branch: 'main',
  owner: { login: 'acme', id: 300001 },
});

const FIXTURES: MockFixtures = {
  repositories: {
    ...MOCK_FIXTURES.repositories,
    [STRICT.repo]: {
      installationId: STRICT.installationId,
      environmentsRead: true,
      repository: repository(STRICT.repositoryId, STRICT.repo),
      files: { [WORKFLOW_PATH]: WORKFLOW_TEXT },
      environments: {
        'team-console': {
          environment: {
            id: 1,
            created_at: '2026-11-01T00:00:00Z',
            protection_rules: [
              { id: 2, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: REVIEWER_SENTINEL } }] },
              { id: 3, type: 'wait_timer', wait_timer: 0 },
              { id: 4, type: 'branch_policy' },
              { id: 5, type: 'required_reviewers', reviewers: [] },
            ],
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          },
          branchPolicies: [{ id: 6, name: 'main', type: 'branch' }, { id: 7, name: 'release-*' }],
          secrets: ['TC_INFERENCE_API_KEY', OTHER_SECRET_SENTINEL],
        },
        staging: { environment: { deployment_branch_policy: null } },
      },
    },
    [BARE.repo]: {
      installationId: BARE.installationId,
      environmentsRead: true,
      repository: repository(BARE.repositoryId, BARE.repo),
      environments: {
        'team-console': {
          environment: { protection_rules: [{ id: 8, type: 'wait_timer', wait_timer: 30 }], deployment_branch_policy: null },
          secrets: [OTHER_SECRET_SENTINEL],
        },
      },
    },
    [BIG.repo]: {
      installationId: BIG.installationId,
      environmentsRead: true,
      repository: repository(BIG.repositoryId, BIG.repo),
      files: { [WORKFLOW_PATH]: 'x'.repeat(RUNNER_WORKFLOW_MAX_BYTES + 1) },
    },
  },
};

const noAudit: ScopedMintAudit = async () => undefined;

describe('Actions setup readiness reads (#759)', () => {
  let mock: MockGitHub;
  let auth: GitHubAppAuth;
  const paths: string[] = [];
  let fetch: FetchLike;

  beforeAll(async () => {
    mock = await createMockGitHub(FIXTURES);
    fetch = async (input, init) => {
      paths.push(`${init.method ?? 'GET'} ${new URL(input).pathname}`);
      return mock.fetch(input, init);
    };
    auth = new GitHubAppAuth(mock.credentials, { fetch });
  });

  beforeEach(() => {
    paths.length = 0;
  });

  const readToken = (target: { installationId: number; repositoryId: number }) =>
    auth.mintScoped('environment-read', target, noAudit);

  describe('readActionsEnvironment', () => {
    it('reduces the Environment to its branch policy and rule types, without reviewers or dates', async () => {
      const token = await readToken(STRICT);
      const environment = await readActionsEnvironment(fetch, token, parseRepoName(STRICT.repo));
      expect(environment).toEqual({
        id: 1,
        branchPolicy: { protectedBranches: false, customBranchPolicies: true },
        protectionRules: ['required_reviewers', 'branch_policy'],
      });
      expect(JSON.stringify(environment)).not.toContain(REVIEWER_SENTINEL);
      expect(paths.at(-1)).toBe('GET /repos/acme/strict/environments/team-console');
    });

    it('reports a wait timer above zero and an Environment every branch may deploy to', async () => {
      const token = await readToken(BARE);
      await expect(readActionsEnvironment(fetch, token, parseRepoName(BARE.repo))).resolves.toEqual({
        id: null,
        branchPolicy: null,
        protectionRules: ['wait_timer'],
      });
    });

    it('answers null for a repository without the team-console Environment', async () => {
      const token = await readToken(BIG);
      await expect(readActionsEnvironment(fetch, token, parseRepoName(BIG.repo))).resolves.toBeNull();
      await expect(hasInferenceKeySecret(fetch, token, parseRepoName(BIG.repo))).resolves.toBe(false);
      await expect(readDeploymentBranchPolicies(fetch, token, parseRepoName(BIG.repo))).resolves.toBeNull();
    });

    it('reads the default mock world’s ready Environment (geeera/team-console)', async () => {
      const token = await readToken({ installationId: 1001, repositoryId: 900001 });
      const repo = parseRepoName('geeera/team-console');
      await expect(readActionsEnvironment(fetch, token, repo)).resolves.toEqual({
        id: 7001,
        branchPolicy: { protectedBranches: false, customBranchPolicies: true },
        protectionRules: ['branch_policy'],
      });
      await expect(hasInferenceKeySecret(fetch, token, repo)).resolves.toBe(true);
    });

    it('refuses a body that is not the team-console Environment with 502 github-unexpected', async () => {
      const token = new ScopedInstallationToken('environment-read', 1, 1, installationToken('x'));
      const odd: FetchLike = async () => Response.json({ name: 'production', protection_rules: [] });
      const error = await readActionsEnvironment(odd, token, parseRepoName(STRICT.repo)).catch((caught: unknown) => caught);
      expect((error as GitHubError).problem.type).toBe('github-unexpected');
    });
  });

  describe('readDeploymentBranchPolicies', () => {
    it('lists the name patterns with their ref types; a policy without a type is a branch policy', async () => {
      const token = await readToken(STRICT);
      await expect(readDeploymentBranchPolicies(fetch, token, parseRepoName(STRICT.repo))).resolves.toEqual({
        policies: [
          { name: 'main', type: 'branch' },
          { name: 'release-*', type: 'branch' },
        ],
        complete: true,
      });
      expect(paths.at(-1)).toBe('GET /repos/acme/strict/environments/team-console/deployment-branch-policies');
    });

    it('answers null when GitHub has no policy list (404)', async () => {
      const token = new ScopedInstallationToken('environment-read', 1, 1, installationToken('x'));
      const missing: FetchLike = async () => Response.json({ message: 'Not Found' }, { status: 404 });
      await expect(readDeploymentBranchPolicies(missing, token, parseRepoName(STRICT.repo))).resolves.toBeNull();
    });

    it('marks a list longer than one page as incomplete', async () => {
      const token = new ScopedInstallationToken('environment-read', 1, 1, installationToken('x'));
      const paged: FetchLike = async () => Response.json({ total_count: 101, branch_policies: [{ name: 'main', type: 'branch' }] });
      await expect(readDeploymentBranchPolicies(paged, token, parseRepoName(STRICT.repo))).resolves.toMatchObject({
        complete: false,
      });
    });
  });

  describe('hasInferenceKeySecret', () => {
    it('reads the one secret by name, never the list, and passes on a boolean alone', async () => {
      const token = await readToken(STRICT);
      await expect(hasInferenceKeySecret(fetch, token, parseRepoName(STRICT.repo))).resolves.toBe(true);
      expect(paths.at(-1)).toBe('GET /repos/acme/strict/environments/team-console/secrets/TC_INFERENCE_API_KEY');
      expect(paths.some((path) => /\/secrets$|\/variables/.test(path))).toBe(false);
    });

    it('answers false when only other secrets exist', async () => {
      const token = await readToken(BARE);
      await expect(hasInferenceKeySecret(fetch, token, parseRepoName(BARE.repo))).resolves.toBe(false);
    });

    it('is refused for the cached read token, which holds no Environments permission', async () => {
      const read = await auth.tokenSourceFor(parseRepoName(STRICT.repo)).getToken();
      const forged = new ScopedInstallationToken('environment-read', STRICT.installationId, STRICT.repositoryId, read);
      const error = await hasInferenceKeySecret(fetch, forged, parseRepoName(STRICT.repo)).catch((caught: unknown) => caught);
      expect((error as GitHubError).githubStatus).toBe(403);
    });
  });

  it('takes an environment-read token only, whatever a cast says', async () => {
    const dispatch = new ScopedInstallationToken('actions-dispatch', 1, 1, installationToken('x'));
    const forged = dispatch as unknown as ScopedInstallationToken<'environment-read'>;
    await expect(hasInferenceKeySecret(fetch, forged, parseRepoName(STRICT.repo))).rejects.toThrow(TypeError);
    await expect(readActionsEnvironment(fetch, forged, parseRepoName(STRICT.repo))).rejects.toThrow(TypeError);
    await expect(readDeploymentBranchPolicies(fetch, forged, parseRepoName(STRICT.repo))).rejects.toThrow(TypeError);
    expect(paths).toEqual([]);
  });

  it('spends the environment-read token on these three reads only (the mock refuses it elsewhere)', async () => {
    const token = await readToken(STRICT);
    const response = await mock.fetch('https://api.github.com/repos/acme/strict/environments/team-console/variables', {
      method: 'GET',
      headers: { authorization: `Bearer ${token.bearer()}` },
    });
    expect(response.status).toBe(403);
    const contents = await mock.fetch(`https://api.github.com/repos/acme/strict/contents/${WORKFLOW_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token.bearer()}` },
    });
    expect(contents.status).toBe(403);
  });

  describe('readRunnerWorkflowFile', () => {
    const client = (repo: string) => new GitHubClient(fetch, auth.tokenSourceFor(parseRepoName(repo)));

    it('reads the file’s exact bytes on the default branch', async () => {
      const read = await readRunnerWorkflowFile(client(STRICT.repo), parseRepoName(STRICT.repo), 'main');
      expect(read.kind).toBe('file');
      expect(read.kind === 'file' ? read.bytes : null).toEqual(new TextEncoder().encode(WORKFLOW_TEXT));
      expect(paths.at(-1)).toBe(`GET /repos/acme/strict/contents/${WORKFLOW_PATH}`);
    });

    it('answers missing when the repository has no such file', async () => {
      await expect(readRunnerWorkflowFile(client(BARE.repo), parseRepoName(BARE.repo), 'main')).resolves.toEqual({
        kind: 'missing',
      });
    });

    it('stops at RUNNER_WORKFLOW_MAX_BYTES', async () => {
      await expect(readRunnerWorkflowFile(client(BIG.repo), parseRepoName(BIG.repo), 'main')).resolves.toEqual({
        kind: 'too-large',
      });
    });
  });
});
