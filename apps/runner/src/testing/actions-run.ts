import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixtureGit, makeFixtureRepo, CLAUDE_FAKE } from './job-fixture';

/**
 * What a GitHub Actions run gives `run-once --oidc`, for its specs (#669): a short `RUNNER_TEMP` (the job socket
 * under `$RUNNER_TEMP/tc/jobs/<id>/sock` must fit macOS' 104-byte `sun_path`), the run's own repository as a bare
 * repository a git HTTP server can serve, and the env GitHub and the workflow template set. Every secret is a
 * synthetic value built at run time.
 */

export const ACTIONS_REPOSITORY = 'acme-org/acme-app';

/** `/tmp/…` where there is one: the platform tmpdir on macOS is too deep for the job socket under it. */
export async function shortTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(existsSync('/tmp') ? '/tmp' : tmpdir(), prefix));
}

/** `<root>/<owner>/<name>.git`, a bare copy of a fixture product repository with the vendored plugin. */
export function makeBareRepository(root: string, repository: string = ACTIONS_REPOSITORY): string {
  const work = makeFixtureRepo(join(root, 'work'));
  const bare = join(root, `${repository}.git`);
  fixtureGit(['clone', '--bare', '-q', work, bare]);
  return bare;
}

/** Synthetic secrets of one Actions run, shaped as GitHub and Anthropic issue them. */
export const actionsSecrets = {
  inferenceKey: `sk-ant-api03-${'A'.repeat(40)}`,
  idTokenRequestToken: `${'R'.repeat(24)}.${'r'.repeat(40)}`,
  readToken: `ghs_${'G'.repeat(36)}`,
} as const;

export interface ActionsEnvInput {
  readonly consoleUrl: string;
  readonly jobId: string;
  readonly runnerTemp: string;
  readonly idTokenUrl: string;
  readonly serverUrl: string;
  readonly audience?: string;
}

/** The env of the runner's step: what the template's `env:` and GitHub's runner put there. */
export function actionsEnvOf(input: ActionsEnvInput): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: input.runnerTemp,
    TC_CONSOLE_URL: input.consoleUrl,
    TC_JOB_ID: input.jobId,
    TC_CONSOLE_AUDIENCE: input.audience ?? 'team-console:local',
    TC_INFERENCE_API_KEY: actionsSecrets.inferenceKey,
    TC_CLAUDE_COMMAND: CLAUDE_FAKE,
    RUNNER_TEMP: input.runnerTemp,
    ACTIONS_ID_TOKEN_REQUEST_URL: input.idTokenUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: actionsSecrets.idTokenRequestToken,
    GITHUB_SERVER_URL: input.serverUrl,
    GITHUB_REPOSITORY: ACTIONS_REPOSITORY,
    GITHUB_TOKEN: actionsSecrets.readToken,
    GITHUB_RUN_ID: '9123456789',
  };
}

/** Where the specs' node lives: the job's PATH starts there, as it does on the VM. */
export const NODE_DIR = dirname(process.execPath);

/** An RS256 issuer of this run only, standing in for GitHub's: its JWKS goes to the local stack's `ACTIONS_OIDC_JWKS`. */
export interface TestIssuer {
  readonly jwks: string;
  sign(claims: Readonly<Record<string, unknown>>): string;
}

export function createTestIssuer(): TestIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `test-${randomUUID()}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    jwks: JSON.stringify({ keys: [jwk] }),
    sign: (claims) => {
      const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
      return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
    },
  };
}

/** The claims GitHub puts in a `workflow_dispatch` run of the runner workflow on `main`, for `audience`. */
export function runClaimsOf(
  input: { readonly repositoryId: number; readonly runId: string; readonly audience: string },
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const workflowRef = `${ACTIONS_REPOSITORY}/.github/workflows/team-console-runner.yml@refs/heads/main`;
  return {
    iss: 'https://token.actions.githubusercontent.com',
    aud: input.audience,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: randomUUID(),
    sub: `repo:${ACTIONS_REPOSITORY}:environment:team-console`,
    repository: ACTIONS_REPOSITORY,
    repository_id: String(input.repositoryId),
    ref: 'refs/heads/main',
    ref_type: 'branch',
    workflow_ref: workflowRef,
    job_workflow_ref: workflowRef,
    event_name: 'workflow_dispatch',
    environment: 'team-console',
    runner_environment: 'github-hosted',
    run_id: input.runId,
    run_attempt: '1',
    ...overrides,
  };
}

export interface TokenEndpoint {
  /** `ACTIONS_ID_TOKEN_REQUEST_URL` of this endpoint. */
  readonly url: string;
  /** The audiences asked for, in order. */
  readonly audiences: readonly string[];
  close(): Promise<void>;
}

/**
 * GitHub's OIDC token endpoint on loopback: a request with the run's request token as the bearer gets
 * `{ value: <token> }` for the audience it asked for, signed by `issuer` with `claimsFor(audience)`; anything else 401.
 */
export async function startTokenEndpoint(
  issuer: TestIssuer,
  claimsFor: (audience: string) => Record<string, unknown>,
): Promise<TokenEndpoint> {
  const audiences: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.headers.authorization !== `Bearer ${actionsSecrets.idTokenRequestToken}`) {
      response.writeHead(401).end();
      return;
    }
    const audience = url.searchParams.get('audience') ?? '';
    audiences.push(audience);
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ count: 1, value: issuer.sign(claimsFor(audience)) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/_apis/distributedtask/token?api-version=2.0`,
    audiences,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
