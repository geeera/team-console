import { readFile, rm } from 'node:fs/promises';
import {
  OWNER_ACCOUNT_ID,
  isJobDto,
  isJobEventListDto,
  isRunnerListDto,
  roleOfJobKind,
  type JobDto,
  type JobEventDto,
} from '@shared/contracts';
import { EXIT_FAILED, EXIT_OK, runCli } from '../cli/cli';
import { removeTree } from '../git/workspace';
import {
  ACTIONS_REPOSITORY,
  NODE_DIR,
  actionsEnvOf,
  actionsSecrets,
  createTestIssuer,
  makeBareRepository,
  runClaimsOf,
  shortTempDir,
  startTokenEndpoint,
  type TestIssuer,
  type TokenEndpoint,
} from '../testing/actions-run';
import { basicAuthorizationOf, startGitHttpServer, type GitHttpServer } from '../testing/git-http-server';
import { SCENARIO } from '../testing/job-fixture';
import { startLocalStack, type LocalStack } from '../testing/local-stack';

/**
 * #669's integration (acceptance criterion 8; the harness of #668's PR #693): the api Worker on a fresh local D1 with
 * a test RS256 JWKS as `ACTIONS_OIDC_JWKS` (honoured on ENVIRONMENT=local only), a project dispatched to Actions with
 * its repository id and default branch, a queued `dispatch = 'actions'` job, GitHub's token endpoint and clone
 * endpoint on loopback, and the real runner CLI — `run-once --oidc` — running the fake Claude CLI. What the console
 * holds is read back through the owner's API, as the board does.
 */

const SLUG = 'acme-app';
const REPO_ID = 880_669;
const AUDIENCE = 'team-console:local';

describe('integration: run-once --oidc against the local stack', () => {
  let stack: LocalStack;
  let issuer: TestIssuer;
  let tokens: TokenEndpoint;
  let git: GitHttpServer;
  let repos: string;
  const temps: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let runCounter = 0;
  /** What the token endpoint signs next: a fresh run id per call unless a case pins one. */
  let nextClaims: (audience: string) => Record<string, unknown> = () => ({});

  const freshRunId = (): string => {
    runCounter += 1;
    return String(9_100_000_000 + runCounter);
  };

  async function cli(jobId: string): Promise<{ exit: number; out: string[]; err: string[] }> {
    const runnerTemp = await shortTempDir('i-');
    temps.push(runnerTemp);
    const runOut: string[] = [];
    const runErr: string[] = [];
    const exit = await runCli(['run-once', '--oidc'], {
      env: actionsEnvOf({
        consoleUrl: stack.origin,
        jobId,
        runnerTemp,
        idTokenUrl: tokens.url,
        serverUrl: git.origin,
        audience: AUDIENCE,
      }),
      homeDir: runnerTemp,
      host: { os: 'linux', arch: 'x64', hostname: 'fv-az123-456' },
      fetch: (url, init) => fetch(url, init),
      stdout: (line) => runOut.push(line),
      stderr: (line) => runErr.push(line),
      nodeDir: NODE_DIR,
    });
    out.push(...runOut);
    err.push(...runErr);
    return { exit, out: runOut, err: runErr };
  }

  let jobCounter = 0;
  async function queueActionsJob(scenario: number): Promise<string> {
    jobCounter += 1;
    const id = `01KA0000000000000000000J${String(jobCounter).padStart(2, '0')}`;
    // Straight into D1 as #668's harness does, standing in for the console's enqueue and dispatch (#670): the
    // exchange takes only a job the console dispatched (`dispatched_at`, #695 item 3).
    const now = new Date().toISOString();
    await stack.d1(
      `INSERT INTO jobs (id, account_id, project_slug, kind, role, requested_by, created_at, dispatch, dispatched_at, payload, max_minutes) VALUES ('${id}', '${OWNER_ACCOUNT_ID}', '${SLUG}', 'slot-dev', '${roleOfJobKind('slot-dev', null)}', 'owner', '${now}', 'actions', '${now}', '{"items":[${String(scenario)}]}', 5)`,
    );
    return id;
  }

  async function readBack(jobId: string): Promise<{ job: JobDto; events: readonly JobEventDto[]; raw: string }> {
    const jobText = await (await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs/${jobId}`)).text();
    const eventsText = await (
      await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs/${jobId}/events?limit=100`)
    ).text();
    const job: unknown = JSON.parse(jobText);
    const events: unknown = JSON.parse(eventsText);
    if (!isJobDto(job) || !isJobEventListDto(events)) {
      throw new Error(`unexpected read-back: ${jobText.slice(0, 200)} ${eventsText.slice(0, 200)}`);
    }
    return { job, events: events.events, raw: `${jobText}\n${eventsText}` };
  }

  function show(label: string, job: JobDto, events: readonly JobEventDto[]): void {
    // The integration run's evidence (pasted into the PR): what the console holds for the job.
    console.info(
      `[${label}] job ${job.id} ${job.state} runner=${String(job.runnerId)} result=${JSON.stringify(job.result)}\n` +
        events.map((event) => `  #${String(event.seq)} ${event.level} ${event.kind} ${JSON.stringify(event.payload)}`).join('\n'),
    );
  }

  async function liveRunners(): Promise<string[]> {
    const list: unknown = await (await fetch(`${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`)).json();
    if (!isRunnerListDto(list)) {
      throw new Error('the runner list did not answer a RunnerListDto');
    }
    return list.runners.map((runner) => `${runner.name} (revokedAt ${String(runner.revokedAt)})`);
  }

  beforeAll(async () => {
    issuer = createTestIssuer();
    stack = await startLocalStack(93, { vars: { ACTIONS_OIDC_JWKS: issuer.jwks } });
    await stack.d1(
      `INSERT INTO projects (slug, repo, display_name, added_at, account_id, repo_id, default_branch, dispatch, access_source) VALUES ('${SLUG}', '${ACTIONS_REPOSITORY}', 'Acme App', '2026-11-01T00:00:00.000Z', '${OWNER_ACCOUNT_ID}', ${String(REPO_ID)}, 'main', 'actions', 'api_key')`,
    );
    tokens = await startTokenEndpoint(issuer, (audience) => nextClaims(audience));
    repos = await shortTempDir('g-');
    makeBareRepository(repos);
    git = await startGitHttpServer(repos, basicAuthorizationOf(actionsSecrets.readToken));
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
    await tokens.close();
    await git.close();
    await rm(repos, { recursive: true, force: true });
    for (const temp of temps) {
      await removeTree(temp);
    }
  }, 30_000);

  it('exchanges, runs the job through the ordinary protocol, and the identity is gone at finish', async () => {
    // 1. A good run: the token for the console's audience, the exchange, the job, the finish.
    const runId = freshRunId();
    nextClaims = (audience) => runClaimsOf({ repositoryId: REPO_ID, runId, audience });
    const okId = await queueActionsJob(SCENARIO.ok);
    const ok = await cli(okId);
    expect(ok.err.filter((line) => line.includes('refused'))).toEqual([]);
    expect(ok.exit).toBe(EXIT_OK);
    expect(ok.out).toEqual([okId]);
    expect(tokens.audiences.at(-1)).toBe(AUDIENCE);
    const done = await readBack(okId);
    show('ok', done.job, done.events);
    expect(done.job).toMatchObject({
      state: 'finished',
      dispatch: 'actions',
      result: { summary: 'Done: nothing to do', metrics: { exitCode: 0, costUsd: 0.0123, turns: 3 } },
    });
    expect(done.events.find((event) => event.kind === 'started')?.payload).toMatchObject({ backend: 'actions-ephemeral' });
    expect(done.events.at(-1)?.kind).toBe('finished');
    const envNames = /env: ([A-Z0-9_,]+)/.exec(done.raw)?.[1]?.split(',') ?? [];
    expect(envNames).toContain('ANTHROPIC_API_KEY');
    expect(envNames).not.toContain('TC_INFERENCE_API_KEY');
    expect(envNames).not.toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
    expect(envNames).not.toContain('GITHUB_TOKEN');
    // The clone read the run's repository with the read token.
    expect(git.authorizations).toContain(basicAuthorizationOf(actionsSecrets.readToken));
    // 2. `finish` revoked the ephemeral identity: the runners list leaves it out.
    const runners = await liveRunners();
    console.info(`[runners after finish] ${JSON.stringify(runners)}`);
    expect(runners.filter((name) => name.startsWith('actions:'))).toEqual([]);

    // 3. The same run's token again (a replay), for a second queued job: refused, plain message, non-zero.
    const replayId = await queueActionsJob(SCENARIO.ok);
    const replay = await cli(replayId);
    console.info(`[replay] exit ${String(replay.exit)}: ${replay.err.join(' | ')}`);
    expect(replay.exit).toBe(EXIT_FAILED);
    expect(replay.out).toEqual([]);
    expect(replay.err.join('\n')).toMatch(/401 \(oidc-exchange-refused, claim run_id\)/);
    expect((await readBack(replayId)).job.state).toBe('queued');

    // 4. A token of another Environment (no key policy): refused naming the claim.
    nextClaims = (audience) => runClaimsOf({ repositoryId: REPO_ID, runId: freshRunId(), audience }, { environment: 'production' });
    const wrongEnv = await cli(replayId);
    console.info(`[environment] exit ${String(wrongEnv.exit)}: ${wrongEnv.err.join(' | ')}`);
    expect(wrongEnv.exit).toBe(EXIT_FAILED);
    expect(wrongEnv.err.join('\n')).toMatch(/claim environment/);

    // 5. A self-hosted Actions runner (owner decision 2 on #573): refused.
    nextClaims = (audience) =>
      runClaimsOf({ repositoryId: REPO_ID, runId: freshRunId(), audience }, { runner_environment: 'self-hosted' });
    const selfHosted = await cli(replayId);
    expect(selfHosted.exit).toBe(EXIT_FAILED);
    expect(selfHosted.err.join('\n')).toMatch(/claim runner_environment/);

    // 6. A second exchange for a job already run: 409.
    nextClaims = (audience) => runClaimsOf({ repositoryId: REPO_ID, runId: freshRunId(), audience });
    const again = await cli(okId);
    console.info(`[second exchange] exit ${String(again.exit)}: ${again.err.join(' | ')}`);
    expect(again.exit).toBe(EXIT_FAILED);
    expect(again.err.join('\n')).toMatch(/409 \(oidc-exchange-refused, claim job_id\)/);

    // 7. Sentinel: the CLI prints the inference key and other secret shapes; none reaches the console or an output.
    const sentinelId = await queueActionsJob(SCENARIO.sentinel);
    const sentinel = await cli(sentinelId);
    expect(sentinel.exit).toBe(EXIT_OK);
    expect(sentinel.out).toEqual([sentinelId]);
    const leaked = await readBack(sentinelId);
    show('sentinel', leaked.job, leaked.events);
    expect(leaked.raw).toContain('[redacted:');
    const apiLog = await readFile(stack.logPath, 'utf8');
    const output = [...out, ...err].join('\n');
    for (const secret of [
      actionsSecrets.inferenceKey,
      actionsSecrets.idTokenRequestToken,
      actionsSecrets.readToken,
      basicAuthorizationOf(actionsSecrets.readToken),
    ]) {
      expect(leaked.raw).not.toContain(secret);
      expect(output).not.toContain(secret);
      expect(apiLog).not.toContain(secret);
    }
    // No OIDC token (any JWS shape), no job token anywhere a person reads.
    for (const text of [leaked.raw, output, apiLog]) {
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./);
      expect(text).not.toMatch(/tcj_[A-Za-z0-9_-]{43}/);
    }
    expect(out.every((line) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(line))).toBe(true);
  }, 180_000);
});
