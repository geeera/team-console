import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isEd25519PublicJwk,
  resolveTeamConfig,
  type FinishJobInput,
  type JobEventInput,
} from '@shared/contracts';
import {
  ACTIONS_REPOSITORY,
  NODE_DIR,
  actionsEnvOf,
  actionsSecrets,
  makeBareRepository,
  shortTempDir,
} from '../testing/actions-run';
import { JOB_ID, RUNNER_ID, fakeConsole, jobFixture, json, problem, type RecordedRequest } from '../testing/fake-console';
import { basicAuthorizationOf, startGitHttpServer, type GitHttpServer } from '../testing/git-http-server';
import { removeTree } from '../git/workspace';
import { SCENARIO } from '../testing/job-fixture';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runCli } from './cli';
import { actionsRunSettingsOf } from './run-once-oidc';

/**
 * `run-once --oidc` end to end against a fake console and GitHub's token endpoint, with a real git HTTP server for the
 * run's repository and the fake Claude CLI (#669): env-only config, the in-memory key, the token request with the
 * audience, the exchange, the job through the unchanged protocol on `actions-ephemeral`, nothing persisted, stdout
 * only the job id, and no secret of the run in any output or body.
 */

const TOKEN_ENDPOINT = 'http://127.0.0.1:1/_apis/token?api-version=2.0';
const CONSOLE = 'http://127.0.0.1:2';
const JOB_TOKEN = `tcj_${'J'.repeat(43)}`;
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A token shaped as GitHub's (a compact JWS); never verified here, only carried. */
const ID_TOKEN = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k' })}.${b64({ aud: 'team-console:local', run_id: '9123456789' })}.${'s'.repeat(86)}`;

interface Wire {
  readonly requests: RecordedRequest[];
  readonly events: JobEventInput[];
  readonly finished: FinishJobInput[];
}

function exchangeAnswer(items: readonly number[]): Response {
  return json(200, {
    job: jobFixture({ items: [...items], dispatch: 'actions', maxMinutes: 5 }),
    jobToken: JOB_TOKEN,
    leaseSeconds: 300,
    teamConfig: resolveTeamConfig(null, { revision: 0, accessSource: 'api_key' }),
    teamConfigRevision: null,
    runner: { id: RUNNER_ID, audience: 'team-console:local' },
  });
}

describe('run-once --oidc', () => {
  let temp: string;
  let repos: string;
  let git: GitHttpServer;
  let out: string[];
  let err: string[];

  beforeAll(async () => {
    repos = await shortTempDir('g-');
    makeBareRepository(repos);
    git = await startGitHttpServer(repos, basicAuthorizationOf(actionsSecrets.readToken));
  });

  afterAll(async () => {
    await git.close();
    await rm(repos, { recursive: true, force: true });
  });

  beforeEach(async () => {
    temp = await shortTempDir('a-');
    out = [];
    err = [];
  });

  afterEach(async () => {
    // The vendored plugin is left read-only; removeTree makes it writable first.
    await removeTree(temp);
  });

  function run(
    options: {
      env?: Record<string, string | undefined>;
      exchange?: () => Response;
      token?: () => Response;
      argv?: readonly string[];
    } = {},
  ): { exit: Promise<number>; wire: Wire } {
    const events: JobEventInput[] = [];
    const finished: FinishJobInput[] = [];
    const fake = fakeConsole((request) => {
      if (request.url.startsWith('http://127.0.0.1:1/')) {
        return options.token?.() ?? json(200, { count: 1, value: ID_TOKEN });
      }
      if (request.url === `${CONSOLE}/api/v1/runner/oidc-exchange`) {
        return options.exchange?.() ?? exchangeAnswer([SCENARIO.ok]);
      }
      if (request.url.endsWith('/events')) {
        const body = JSON.parse(request.body ?? '{}') as { events: JobEventInput[] };
        events.push(...body.events);
        return json(201, { lastSeq: events.length, capped: false });
      }
      if (request.url.endsWith('/heartbeat')) {
        return json(200, { leaseUntil: new Date(Date.now() + 300_000).toISOString() });
      }
      if (request.url.endsWith('/finish')) {
        finished.push(JSON.parse(request.body ?? '{}') as FinishJobInput);
        return json(200, {});
      }
      return json(404, {});
    });
    const env = {
      ...actionsEnvOf({
        consoleUrl: CONSOLE,
        jobId: JOB_ID,
        runnerTemp: temp,
        idTokenUrl: TOKEN_ENDPOINT,
        serverUrl: git.origin,
      }),
      ...options.env,
    };
    const exit = runCli(options.argv ?? ['run-once', '--oidc'], {
      env,
      homeDir: temp,
      host: { os: 'linux', arch: 'x64', hostname: 'fv-az123-456' },
      fetch: fake.fetch,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      nodeDir: NODE_DIR,
    });
    return { exit, wire: { requests: fake.requests, events, finished } };
  }

  const tokenRequests = (wire: Wire) => wire.requests.filter((request) => request.url.startsWith('http://127.0.0.1:1/'));
  const exchanges = (wire: Wire) => wire.requests.filter((request) => request.url.endsWith('/oidc-exchange'));

  it('exchanges the run’s OIDC token and runs the job on actions-ephemeral, printing only the job id', async () => {
    const { exit, wire } = run();
    expect(await exit).toBe(EXIT_OK);

    expect(out).toEqual([JOB_ID]);
    // The token request: GitHub's URL with the console's audience, the request token as the bearer, no redirects.
    const [tokenRequest] = tokenRequests(wire);
    const tokenUrl = new URL(tokenRequest?.url ?? '');
    expect(tokenUrl.searchParams.get('audience')).toBe('team-console:local');
    expect(tokenUrl.searchParams.get('api-version')).toBe('2.0');
    expect(tokenRequest?.headers['authorization']).toBe(`Bearer ${actionsSecrets.idTokenRequestToken}`);
    expect(tokenRequest?.redirect).toBe('manual');
    // The exchange: the token, the job, a fresh Ed25519 public key (no private part), the host.
    const [exchange] = exchanges(wire);
    const body = JSON.parse(exchange?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['host', 'idToken', 'jobId', 'publicKey', 'version']);
    expect(body).toMatchObject({ idToken: ID_TOKEN, jobId: JOB_ID, host: { os: 'linux', hostname: 'fv-az123-456' } });
    expect(isEd25519PublicJwk(body['publicKey'])).toBe(true);
    expect(body['publicKey']).not.toHaveProperty('d');
    expect(exchange?.headers['authorization']).toBeUndefined();
    // The job's own calls carry runner JWTs of the exchanged identity: EdDSA, `sub` the runner, `aud` the console's.
    const jobCalls = wire.requests.filter((request) => request.url.includes(`/runner/jobs/${JOB_ID}/`));
    expect(jobCalls.length).toBeGreaterThan(0);
    for (const call of jobCalls) {
      const jwt = (call.headers['authorization'] ?? '').replace(/^Bearer /, '');
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
      expect(claims).toMatchObject({ sub: RUNNER_ID, aud: 'team-console:local' });
    }
    expect(wire.requests.some((request) => request.url.endsWith('/jobs/claim'))).toBe(false);

    expect(wire.events.find((event) => event.kind === 'started')?.payload).toMatchObject({ backend: 'actions-ephemeral' });
    expect(wire.finished).toEqual([expect.objectContaining({ result: 'finished', summary: 'Done: nothing to do' })]);
  });

  it('builds the job env from nothing: the key as ANTHROPIC_API_KEY, none of the run’s own variables', async () => {
    const { exit, wire } = run();
    expect(await exit).toBe(EXIT_OK);
    const envLine = wire.events
      .map((event) => JSON.stringify(event.payload))
      .find((payload) => payload.includes('env: '));
    const names = /env: ([A-Z0-9_,]+)/.exec(envLine ?? '')?.[1]?.split(',') ?? [];
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('TC_JOB_TOKEN');
    for (const name of [
      'TC_INFERENCE_API_KEY',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_REPOSITORY',
      'GITHUB_RUN_ID',
      'RUNNER_TEMP',
      'TC_CONSOLE_AUDIENCE',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it('clones with the read token through git’s env config, and keeps nothing behind', async () => {
    const seen = git.authorizations.length;
    const { exit } = run();
    expect(await exit).toBe(EXIT_OK);
    // The server refuses a request without the token, so the mirror was fetched with it.
    expect(git.authorizations.slice(seen)).toContain(basicAuthorizationOf(actionsSecrets.readToken));
    // Nothing persisted: no config, key, state or credential file; the job's sandbox is wiped.
    const home = join(temp, 'tc');
    const left = await readdir(home);
    for (const name of ['config.json', 'keys', 'state.json', 'credentials']) {
      expect(left).not.toContain(name);
    }
    expect(await readdir(join(home, 'jobs'))).toEqual([]);
    // The mirror's config never holds the token (it travelled in the env of git's process only).
    const mirrorConfig = await readFile(join(home, 'work', 'team-console', 'mirror', 'config'), 'utf8');
    expect(mirrorConfig).toContain(`${git.origin}/${ACTIONS_REPOSITORY}.git`);
    expect(mirrorConfig).not.toContain('extraheader');
    expect(mirrorConfig).not.toContain(actionsSecrets.readToken);
  });

  it('without the read token the mirror fetch is refused and the job finishes failed, still through the console', async () => {
    const { exit, wire } = run({ env: { GITHUB_TOKEN: undefined } });
    expect(await exit).toBe(EXIT_OK);
    expect(out).toEqual([JOB_ID]);
    expect(wire.finished).toEqual([
      expect.objectContaining({ result: 'failed', metrics: expect.objectContaining({ reason: 'runner-error' }) }),
    ]);
    expect(err.join('\n')).toContain('GitError: git clone failed');
  });

  it('sentinel: the key, the OIDC token and the run’s tokens never reach stdout, stderr or a body', async () => {
    // The sentinel scenario prints secret shapes, the inference key's among them, on the CLI's stdout and stderr.
    const { exit, wire } = run({ exchange: () => exchangeAnswer([SCENARIO.sentinel]) });
    expect(await exit).toBe(EXIT_OK);
    const output = [...out, ...err].join('\n');
    const bodies = wire.requests
      .filter((request) => !request.url.endsWith('/oidc-exchange'))
      .map((request) => request.body ?? '')
      .join('\n');
    const tokenSegments = ID_TOKEN.split('.');
    for (const secret of [
      actionsSecrets.inferenceKey,
      actionsSecrets.idTokenRequestToken,
      actionsSecrets.readToken,
      ID_TOKEN,
      ...tokenSegments,
      JOB_TOKEN,
      basicAuthorizationOf(actionsSecrets.readToken),
    ]) {
      expect(output).not.toContain(secret);
      expect(bodies).not.toContain(secret);
    }
    expect(bodies).toContain('[redacted:');
    // The OIDC token goes to the exchange and nowhere else; the request token to GitHub's endpoint only.
    const carrying = wire.requests.filter((request) => JSON.stringify(request).includes(ID_TOKEN));
    expect(carrying.map((request) => request.url)).toEqual([`${CONSOLE}/api/v1/runner/oidc-exchange`]);
    const bearing = wire.requests.filter((request) => JSON.stringify(request).includes(actionsSecrets.idTokenRequestToken));
    expect(bearing).toEqual(tokenRequests(wire));
    expect(out).toEqual([JOB_ID]);
  });

  describe('refusals exit non-zero with a plain message', () => {
    it.each([
      ['TC_CONSOLE_URL', 'TC_CONSOLE_URL is not set'],
      ['TC_JOB_ID', 'TC_JOB_ID is not set'],
      ['TC_CONSOLE_AUDIENCE', 'TC_CONSOLE_AUDIENCE is not set'],
      ['RUNNER_TEMP', 'RUNNER_TEMP is not set'],
      ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_URL is not set'],
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN is not set'],
      ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY is not set'],
    ])('missing %s', async (name, message) => {
      const { exit, wire } = run({ env: { [name]: undefined } });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain(message);
      expect(wire.requests).toEqual([]);
      expect(out).toEqual([]);
    });

    it.each([
      ['TC_CONSOLE_URL', 'http://console.example', 'TC_CONSOLE_URL must be the console origin'],
      ['TC_JOB_ID', '../../x', 'TC_JOB_ID must be a job id'],
      ['TC_CONSOLE_AUDIENCE', 'prod', 'TC_CONSOLE_AUDIENCE must be team-console:<environment>'],
      ['RUNNER_TEMP', 'relative/dir', 'RUNNER_TEMP must be an absolute path'],
      ['ACTIONS_ID_TOKEN_REQUEST_URL', 'http://evil.example/token', 'ACTIONS_ID_TOKEN_REQUEST_URL must be an https URL'],
      ['GITHUB_SERVER_URL', 'http://github.example', 'GITHUB_SERVER_URL must be an https origin'],
      ['GITHUB_REPOSITORY', 'acme/../x', 'GITHUB_REPOSITORY must be <owner>/<name>'],
      ['TC_CLAUDE_COMMAND', 'claude', 'TC_CLAUDE_COMMAND must be an absolute path'],
      ['TC_RUNNER_HOME', '/somewhere/else', 'TC_RUNNER_HOME must be unset or $RUNNER_TEMP/tc'],
    ])('a wrong %s', async (name, value, message) => {
      const { exit, wire } = run({ env: { [name]: value } });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain(message);
      expect(err.join('\n')).not.toContain(value);
      expect(wire.requests).toEqual([]);
    });

    it('a missing inference key, before the job’s one exchange is spent', async () => {
      const { exit, wire } = run({ env: { TC_INFERENCE_API_KEY: undefined } });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err).toEqual([
        'run-once --oidc refused: TC_INFERENCE_API_KEY is missing or not one key; set it as a secret of the team-console Environment.',
      ]);
      expect(wire.requests).toEqual([]);
    });

    it('an inference key that is not one line', async () => {
      const { exit, wire } = run({ env: { TC_INFERENCE_API_KEY: 'two\nlines' } });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain('TC_INFERENCE_API_KEY is missing or not one key');
      expect(wire.requests).toEqual([]);
    });

    it('GitHub refusing the token request (no id-token: write)', async () => {
      const { exit, wire } = run({ token: () => json(403, { message: 'nope' }) });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err).toEqual([
        'run-once --oidc refused: GitHub refused the OIDC token request (403); the workflow needs permissions: id-token: write.',
      ]);
      expect(exchanges(wire)).toEqual([]);
    });

    it('a token endpoint answer that is not a token', async () => {
      const { exit, wire } = run({ token: () => json(200, { value: 'not-a-jwt' }) });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain('did not answer a token');
      expect(exchanges(wire)).toEqual([]);
    });

    it('the console refusing the exchange, naming the claim and never the token', async () => {
      const { exit } = run({
        exchange: () =>
          json(401, {
            type: 'https://team-console/problems/oidc-exchange-refused',
            title: 'Unauthorized',
            status: 401,
            claim: 'environment',
          }),
      });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^run-once --oidc refused: The console refused this run's OIDC exchange: the console answered 401 \(oidc-exchange-refused, claim environment\)/);
      expect(err[0]).not.toContain(ID_TOKEN.split('.')[1]);
      expect(out).toEqual([]);
    });

    it('a second exchange for the job (409)', async () => {
      const { exit } = run({ exchange: () => problem(409, 'oidc-exchange-refused') });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain('409 (oidc-exchange-refused)');
    });

    it('an exchange answer for another job', async () => {
      const { exit, wire } = run({
        exchange: () =>
          json(200, {
            job: jobFixture({ id: '01JC00000000000000000000J2' }),
            jobToken: JOB_TOKEN,
            leaseSeconds: 300,
            teamConfig: resolveTeamConfig(null, { revision: 0, accessSource: 'api_key' }),
            teamConfigRevision: null,
            runner: { id: RUNNER_ID, audience: 'team-console:local' },
          }),
      });
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain('oidc exchange: unexpected answer');
      expect(wire.requests.filter((request) => request.url.includes('/runner/jobs/'))).toEqual([]);
    });

    it('a runner home that already exists (one job per fresh VM)', async () => {
      await mkdir(join(temp, 'tc'));
      const { exit, wire } = run();
      expect(await exit).toBe(EXIT_FAILED);
      expect(err.join('\n')).toContain('already exists');
      expect(wire.requests).toEqual([]);
    });

    it('an unknown flag', async () => {
      const { exit } = run({ argv: ['run-once', '--oidc', '--yes'] });
      expect(await exit).toBe(EXIT_USAGE);
    });
  });

  it('names every missing variable at once, by name only', () => {
    expect(() => actionsRunSettingsOf({}, NODE_DIR)).toThrow(
      /TC_CONSOLE_URL is not set; TC_JOB_ID is not set; TC_CONSOLE_AUDIENCE is not set; RUNNER_TEMP is not set; .*GITHUB_REPOSITORY is not set/,
    );
  });

  it('puts the running node first on the job’s PATH and takes GitHub’s clone URL of the run’s repository', () => {
    const settings = actionsRunSettingsOf(
      {
        ...actionsEnvOf({
          consoleUrl: 'https://console.example',
          jobId: JOB_ID,
          runnerTemp: '/home/runner/work/_temp',
          idTokenUrl: 'https://pipelines.actions.githubusercontent.com/abc/_apis/token?api-version=2.0',
          serverUrl: 'https://github.com',
          audience: 'team-console:prod',
        }),
        TC_CLAUDE_COMMAND: undefined,
        GITHUB_TOKEN: undefined,
      },
      '/opt/hostedtoolcache/node/22.0.0/x64/bin',
    );
    expect(settings).toMatchObject({
      apiUrl: 'https://console.example',
      audience: 'team-console:prod',
      home: '/home/runner/work/_temp/tc',
      upstream: `https://github.com/${ACTIONS_REPOSITORY}.git`,
      readToken: null,
      toolchain: { path: '/opt/hostedtoolcache/node/22.0.0/x64/bin:/usr/local/bin:/usr/bin:/bin', claude: 'claude' },
    });
  });
});
