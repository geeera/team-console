import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { parse } from 'yaml';
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
import { CLAUDE_FAKE, SCENARIO } from '../testing/job-fixture';
import { bundleOptions } from '../../build.mjs';
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
  async function queueActionsJob(scenario: number, runId: string): Promise<string> {
    jobCounter += 1;
    const id = `01KA0000000000000000000J${String(jobCounter).padStart(2, '0')}`;
    // Straight into D1 as #668's harness does, standing in for the console's enqueue and dispatch (#670): the
    // exchange takes only a job the console dispatched (`dispatched_at`, #695 item 3), and only for the run that
    // dispatch started (`actions_run_id`, the `workflow_run_id` GitHub answered, #723 item 2).
    const now = new Date().toISOString();
    await stack.d1(
      `INSERT INTO jobs (id, account_id, project_slug, kind, role, requested_by, created_at, dispatch, dispatched_at, actions_run_id, payload, max_minutes) VALUES ('${id}', '${OWNER_ACCOUNT_ID}', '${SLUG}', 'slot-dev', '${roleOfJobKind('slot-dev', null)}', 'owner', '${now}', 'actions', '${now}', '${runId}', '{"items":[${String(scenario)}]}', 5)`,
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
    const okId = await queueActionsJob(SCENARIO.ok, runId);
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
    const replayId = await queueActionsJob(SCENARIO.ok, freshRunId());
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
    const sentinelRun = freshRunId();
    nextClaims = (audience) => runClaimsOf({ repositoryId: REPO_ID, runId: sentinelRun, audience });
    const sentinelId = await queueActionsJob(SCENARIO.sentinel, sentinelRun);
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

  it('the template’s job step, run by bash on the built bundle, takes the request token on stdin only and ignores SIGUSR1 (#712)', async () => {
    // The VM's layout as the template's earlier steps leave it: node, the release files, the CLI under RUNNER_TEMP.
    const runnerTemp = await shortTempDir('t-');
    temps.push(runnerTemp);
    await mkdir(join(runnerTemp, 'node', 'bin'), { recursive: true });
    await symlink(process.execPath, join(runnerTemp, 'node', 'bin', 'node'));
    // The specs' git next to node (first on the template's PATH): on a Mac /usr/bin/git is Apple's, whose built-in
    // config (`credential.helper`) the runner's allow-list refuses; the VM's /usr/bin/git has none.
    const specGit = execFileSync('sh', ['-c', 'command -v git'], { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } })
      .toString()
      .trim();
    await symlink(specGit, join(runnerTemp, 'node', 'bin', 'git'));
    await mkdir(join(runnerTemp, 'runner', 'bin'), { recursive: true });
    await build({ ...bundleOptions(), outfile: join(runnerTemp, 'runner', 'team-console-runner.mjs'), metafile: false });
    await copyFile(join(import.meta.dirname, '..', '..', 'bin', 'team-console-runner'), join(runnerTemp, 'runner', 'bin', 'team-console-runner'));
    await mkdir(join(runnerTemp, 'claude-code'));
    await symlink(CLAUDE_FAKE, join(runnerTemp, 'claude-code', 'claude'));
    const template = parse(
      await readFile(join(import.meta.dirname, '..', '..', 'templates', 'team-console-runner.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
    const script = Object.values(template.jobs)[0]?.steps.find((step) => step.name === 'Run the job')?.run ?? '';
    expect(script).toContain('--request-token -');
    const scriptPath = join(runnerTemp, 'run-the-job.sh');
    await writeFile(scriptPath, script, { mode: 0o600 });

    const runId = freshRunId();
    nextClaims = (audience) => runClaimsOf({ repositoryId: REPO_ID, runId, audience });
    const jobId = await queueActionsJob(SCENARIO.ok, runId);
    const env: Record<string, string> = {
      ...actionsEnvOf({ consoleUrl: stack.origin, jobId, runnerTemp, idTokenUrl: tokens.url, serverUrl: git.origin, audience: AUDIENCE }),
      PATH: '/usr/bin:/bin',
    };
    // The template sets the CLI's path itself.
    delete env['TC_CLAUDE_COMMAND'];
    // How GitHub runs a `shell: bash` step.
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    // Once the job id is on stdout the exchange is done and the runner supervises the job: the moment a compromised job
    // would send it SIGUSR1 to open the Node inspector (#712). It must neither listen nor die.
    let signalled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk.toString());
      if (!signalled && child.pid !== undefined && stdout.join('').includes(`${jobId}\n`)) {
        process.kill(child.pid, 'SIGUSR1');
        signalled = true;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    // What the job sees of its supervisor: on Linux, /proc/<pid>/environ of the runner the step exec'd (same uid).
    const environSamples: string[] = [];
    if (process.platform === 'linux' && child.pid !== undefined) {
      const pid = child.pid;
      while (child.exitCode === null && child.signalCode === null) {
        try {
          const cmdline = await readFile(`/proc/${String(pid)}/cmdline`, 'utf8');
          if (cmdline.includes('team-console-runner.mjs')) {
            environSamples.push(await readFile(`/proc/${String(pid)}/environ`, 'utf8'));
          }
        } catch (error: unknown) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const code = await exited;
    console.info(`[template job step] exit ${String(code)} stdout ${JSON.stringify(stdout.join(''))} stderr ${JSON.stringify(stderr.join(''))}`);
    expect(signalled).toBe(true);
    expect(code).toBe(EXIT_OK);
    expect(stderr.join('')).not.toContain('Debugger listening');
    // GitHub consumes the `::add-mask::` workflow command; what is left on the log is the job id alone.
    const lines = stdout.join('').split('\n').filter((line) => line !== '');
    expect(lines.filter((line) => !line.startsWith('::add-mask::'))).toEqual([jobId]);
    expect(lines.filter((line) => line.startsWith('::'))).toEqual([`::add-mask::${actionsSecrets.inferenceKey}`]);
    const done = await readBack(jobId);
    show('template', done.job, done.events);
    expect(done.job).toMatchObject({ state: 'finished', dispatch: 'actions', result: { summary: 'Done: nothing to do' } });
    expect(tokens.audiences.at(-1)).toBe(AUDIENCE);
    if (process.platform === 'linux') {
      expect(environSamples.length).toBeGreaterThan(0);
      for (const environ of environSamples) {
        expect(environ).toContain('TC_JOB_ID=');
        expect(environ).not.toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN=');
        expect(environ).not.toContain(actionsSecrets.idTokenRequestToken);
      }
    }
    expect([...stdout, ...stderr].join('')).not.toContain(actionsSecrets.idTokenRequestToken);
  }, 180_000);
});
