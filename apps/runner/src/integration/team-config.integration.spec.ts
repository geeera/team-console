import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_ACCOUNT_ID,
  isEnrolmentCodeDto,
  isJobDto,
  isJobEventListDto,
  type JobDto,
  type JobEventDto,
} from '@shared/contracts';
import { EXIT_OK, runCli } from '../cli/cli';
import { configPathOf, loadRunnerConfig } from '../config/config';
import { writePrivateFile } from '../config/private-files';
import { removeTree } from '../git/workspace';
import { sentinels } from '../testing/fake-console';
import { SCENARIO, makeFixtureRepo, runnerConfigFor } from '../testing/job-fixture';
import { startLocalStack, type LocalStack } from '../testing/local-stack';

/**
 * #685 end to end: the owner saves a team configuration through the console's own route, Run now queues jobs, and
 * the real runner CLI (`run-once`, backend `none`) claims them from the api Worker on a fresh local D1 and launches
 * the fake CLI with what the claim's resolved view says — model, turn limit, effort, the reviewer's diff clone — or
 * refuses a credential that does not match `access.source`. Everything is read back through the console's API.
 */

const SLUG = 'team-console';
const OWNER_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

interface LaunchReport {
  readonly model: string | null;
  readonly maxTurns: string | null;
  readonly settings: Record<string, unknown> | null;
  readonly envNames: readonly string[];
  readonly shallow: boolean;
  readonly promisor: string | null;
}

describe('integration: team configuration → claim → runner launch (#685)', () => {
  let stack: LocalStack;
  let home: string;
  let repoDir: string;
  let revision = 0;
  const out: string[] = [];
  const err: string[] = [];

  const cli = (args: readonly string[]): Promise<number> =>
    runCli(args, {
      env: { TC_RUNNER_HOME: home, PATH: process.env['PATH'] },
      homeDir: home,
      host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
      fetch: (url, init) => fetch(url, init),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

  async function saveTeamConfig(config: unknown): Promise<void> {
    const response = await fetch(`${stack.origin}/api/v1/projects/${SLUG}/team-config`, {
      method: 'PUT',
      headers: { ...OWNER_HEADERS, 'If-Match': `"${String(revision)}"` },
      body: JSON.stringify({ config, reason: 'integration' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revision += 1;
  }

  async function runNow(body: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ items: [SCENARIO.launch], maxMinutes: 5, ...body }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const job: unknown = await response.json();
    if (!isJobDto(job)) {
      throw new Error('Run now did not answer a JobDto');
    }
    return job.id;
  }

  async function runOnce(body: Record<string, unknown>): Promise<{ job: JobDto; events: readonly JobEventDto[]; raw: string }> {
    const id = await runNow(body);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const jobText = await (await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs/${id}`)).text();
    const eventsText = await (await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs/${id}/events?limit=100`)).text();
    const job: unknown = JSON.parse(jobText);
    const events: unknown = JSON.parse(eventsText);
    if (!isJobDto(job) || !isJobEventListDto(events)) {
      throw new Error(`unexpected read-back: ${jobText.slice(0, 200)}`);
    }
    // The run's evidence (pasted into the PR): what the console holds for the job.
    console.info(
      `[${String(body['role'] ?? body['kind'])}] job ${job.id} ${job.state} role=${job.role} result=${JSON.stringify(job.result)}\n` +
        events.events.map((event) => `  #${String(event.seq)} ${event.level} ${event.kind} ${JSON.stringify(event.payload)}`).join('\n'),
    );
    return { job, events: events.events, raw: `${jobText}\n${eventsText}` };
  }

  const reportOf = (job: JobDto): LaunchReport => JSON.parse(String(job.result?.['summary'])) as LaunchReport;
  const teamNoticeOf = (events: readonly JobEventDto[]) =>
    events.find((event) => event.kind === 'notice' && 'cost' in event.payload)?.payload;

  beforeAll(async () => {
    stack = await startLocalStack(94);
    await stack.d1(
      `INSERT INTO projects (slug, repo, display_name, added_at, tracker, key_prefix, cutover_at) VALUES ('${SLUG}', 'geeera/team-console', 'Team Console', '2026-11-01T00:00:00.000Z', 'console', 'TC', '2026-11-01T00:00:00.000Z')`,
    );
    home = await mkdtemp(join(tmpdir(), 'r-'));
    repoDir = await mkdtemp(join(tmpdir(), 'tcr-repo-'));
    makeFixtureRepo(join(repoDir, 'repo'));

    const code = await fetch(`${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ name: 'Team-config runner', allowedProjects: [SLUG] }),
    });
    const enrolment: unknown = await code.json();
    if (!isEnrolmentCodeDto(enrolment)) {
      throw new Error('no enrolment code');
    }
    const enrolled = await runCli(['enrol', '--url', enrolment.apiUrl, '--backend', 'none'], {
      env: { TC_RUNNER_HOME: home, PATH: process.env['PATH'], TC_ENROL_CODE: enrolment.code },
      homeDir: home,
      host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
      fetch: (url, init) => fetch(url, init),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    expect(enrolled).toBe(EXIT_OK);
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
    await removeTree(home);
    await rm(repoDir, { recursive: true, force: true });
  }, 30_000);

  async function configure(withApiKey: boolean): Promise<void> {
    const enrolled = await loadRunnerConfig(home);
    const { toolchain, repositories } = runnerConfigFor(join(repoDir, 'repo'));
    await rm(configPathOf(home));
    await writePrivateFile(
      configPathOf(home),
      JSON.stringify({
        ...enrolled,
        toolchain,
        repositories,
        ...(withApiKey ? { credential: { kind: 'api-key', file: 'credentials/anthropic.key' } } : {}),
      }),
    );
  }

  it('runs each job exactly as the saved configuration says, and refuses a mismatched credential', async () => {
    await mkdir(join(home, 'credentials'), { mode: 0o700, recursive: true });
    await writeFile(join(home, 'credentials', 'anthropic.key'), sentinels.anthropicKey, { mode: 0o600 });

    // 1. No configuration saved: the claim's view is `recommended` on the owner's subscription, no credential needed.
    await configure(false);
    const recommended = await runOnce({ kind: 'slot-dev' });
    expect(recommended.job.state).toBe('finished');
    expect(reportOf(recommended.job)).toMatchObject({ model: 'claude-opus-5-5', maxTurns: '400' });
    expect(reportOf(recommended.job).settings).toMatchObject({ effortLevel: 'high' });
    expect(reportOf(recommended.job).envNames).not.toContain('ANTHROPIC_API_KEY');

    // 2. The owner switches to an API key on economy with a Sonnet orchestrator capped at 25 turns.
    await saveTeamConfig({
      schema: 'team-config/v1',
      preset: 'economy',
      access: { source: 'api_key' },
      roles: { orchestrator: { max_turns: 25, effort: 'low' } },
      cost: { reviewer_context: 'diff' },
    });

    // 2a. The same runner without an API key is refused: the host's Claude login never runs an api_key project.
    const refused = await runOnce({ kind: 'slot-dev' });
    expect(refused.job).toMatchObject({ state: 'failed', result: { metrics: { reason: 'credential-source-mismatch' } } });

    // 2b. With the key: the orchestrator runs on the view's model, turns and effort.
    await configure(true);
    const economy = await runOnce({ kind: 'slot-dev' });
    expect(economy.job.state).toBe('finished');
    expect(reportOf(economy.job)).toMatchObject({ model: 'claude-sonnet-5', maxTurns: '25', shallow: false });
    expect(reportOf(economy.job).settings).toMatchObject({ effortLevel: 'low' });
    expect(reportOf(economy.job).envNames).toContain('ANTHROPIC_API_KEY');
    expect(teamNoticeOf(economy.events)).toMatchObject({
      teamConfig: { revision: 1, source: 'api_key', model: 'claude-sonnet-5', maxTurns: 25, effort: 'low' },
      cost: { prompt_caching: 'applied', batch_api: 'off', reviewer_context: 'not-applicable' },
    });
    expect(economy.job.result?.['metrics']).toMatchObject({ total_cost_usd: 0.0123, inputTokens: 1200, outputTokens: 340 });

    // 3. T11: a reviewer gets the blob-less diff clone, security and qa the full one.
    const reviewer = await runOnce({ kind: 'review', role: 'reviewer' });
    expect(reportOf(reviewer.job)).toMatchObject({ model: 'claude-sonnet-5', shallow: true, promisor: 'true' });
    expect(teamNoticeOf(reviewer.events)).toMatchObject({ cost: { reviewer_context: 'applied' } });
    for (const role of ['security', 'qa']) {
      const full = await runOnce({ kind: 'review', role });
      expect(reportOf(full.job)).toMatchObject({ shallow: false, promisor: null });
    }

    // 4. T7 back to subscription: the API-key credential is refused by its kind, and the key appears nowhere.
    await saveTeamConfig({ schema: 'team-config/v1', access: { source: 'subscription' } });
    const mismatch = await runOnce({ kind: 'slot-dev' });
    expect(mismatch.job).toMatchObject({ state: 'failed', result: { metrics: { reason: 'credential-source-mismatch' } } });
    expect(mismatch.events.find((event) => event.payload['refused'] === 'credential-source-mismatch')?.payload['detail']).toBe(
      "the api-key credential does not match the project's subscription access source",
    );
    for (const text of [mismatch.raw, economy.raw, [...out, ...err].join('\n')]) {
      expect(text).not.toContain(sentinels.anthropicKey);
    }
  }, 180_000);
});
