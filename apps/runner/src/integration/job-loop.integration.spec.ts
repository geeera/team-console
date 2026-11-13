import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_ACCOUNT_ID,
  isEnrolmentCodeDto,
  isJobDto,
  isJobEventListDto,
  isRunnerListDto,
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
 * 2-B-2's integration (architect note on #468, decision 13; #569): the api Worker on a fresh local D1, a project on
 * the console tracker, the owner's Run now, and the real runner CLI — `enrol --backend none`, then `run-once` — running
 * the fake Claude CLI. What the console holds is read back through `GET …/jobs/:id` and `…/events`, as the board does.
 */

const SLUG = 'team-console';
const OWNER_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

describe('integration: Run now → runner → fake CLI → events and finish', () => {
  let stack: LocalStack;
  let home: string;
  let repoDir: string;
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

  async function runNow(scenario: number): Promise<string> {
    const response = await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ kind: 'slot-dev', items: [scenario], maxMinutes: 5 }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const job: unknown = await response.json();
    if (!isJobDto(job)) {
      throw new Error('Run now did not answer a JobDto');
    }
    return job.id;
  }

  async function readBack(
    jobId: string,
  ): Promise<{ job: JobDto; events: readonly JobEventDto[]; raw: string }> {
    const jobResponse = await fetch(`${stack.origin}/api/v1/projects/${SLUG}/jobs/${jobId}`);
    const eventsResponse = await fetch(
      `${stack.origin}/api/v1/projects/${SLUG}/jobs/${jobId}/events?limit=100`,
    );
    const jobText = await jobResponse.text();
    const eventsText = await eventsResponse.text();
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
      `[${label}] job ${job.id} ${job.state} result=${JSON.stringify(job.result)}\n` +
        events
          .map(
            (event) =>
              `  #${String(event.seq)} ${event.level} ${event.kind} ${JSON.stringify(event.payload)}`,
          )
          .join('\n'),
    );
  }

  beforeAll(async () => {
    stack = await startLocalStack(91);
    // Straight into the local D1 like the e2e tracker seed: nothing in the API creates a console-tracker project yet.
    await stack.d1(
      `INSERT INTO projects (slug, repo, display_name, added_at, tracker, key_prefix, cutover_at) VALUES ('${SLUG}', 'geeera/team-console', 'Team Console', '2026-11-01T00:00:00.000Z', 'console', 'TC', '2026-11-01T00:00:00.000Z')`,
    );
    // Short: `jobs/<id>/sock/tc.sock` under it must fit `sun_path`.
    home = await mkdtemp(join(tmpdir(), 'r-'));
    repoDir = await mkdtemp(join(tmpdir(), 'tcr-repo-'));
    makeFixtureRepo(join(repoDir, 'repo'));
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
    await removeTree(home);
    await rm(repoDir, { recursive: true, force: true });
  }, 30_000);

  it('enrols, runs jobs from Run now, and the console shows their events and finish', async () => {
    // 1. Enrol with the owner's one-time code, then add what jobs need to config.json (the operator's step).
    const code = await fetch(`${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ name: 'Integration runner', allowedProjects: [SLUG] }),
    });
    const enrolment: unknown = await code.json();
    if (!isEnrolmentCodeDto(enrolment)) {
      throw new Error('no enrolment code');
    }
    expect(
      await cli(['enrol', '--url', enrolment.apiUrl, '--code', enrolment.code, '--backend', 'none']),
    ).toBe(EXIT_OK);
    const enrolled = await loadRunnerConfig(home);
    const { toolchain, repositories } = runnerConfigFor(join(repoDir, 'repo'));
    await rm(configPathOf(home));
    await writePrivateFile(configPathOf(home), JSON.stringify({ ...enrolled, toolchain, repositories }));

    // 2. Nothing queued: run-once claims nothing.
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    expect(out.at(-1)).toBe('No job is queued for this runner.');

    // 3. Run now → claim → started → the fake CLI's stream → finish, read back through the console's API.
    const okId = await runNow(SCENARIO.ok);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const ok = await readBack(okId);
    show('ok', ok.job, ok.events);
    expect(ok.job).toMatchObject({
      state: 'finished',
      result: {
        summary: 'Done: nothing to do',
        metrics: { exitCode: 0, costUsd: 0.0123, turns: 3 },
        acted: false,
      },
    });
    const kinds = ok.events.map((event) => event.kind);
    expect(kinds[0]).toBe('notice');
    expect(kinds).toContain('started');
    expect(kinds.at(-1)).toBe('finished');
    expect(ok.events.some((event) => event.payload['tool'] === 'Bash')).toBe(true);

    // 4. Sentinel: the job token, an enrolment code, an sk-ant- key and a ghs_ token printed by the CLI.
    const sentinelId = await runNow(SCENARIO.sentinel);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const leaked = await readBack(sentinelId);
    show('sentinel', leaked.job, leaked.events);
    expect(leaked.raw).toContain('[redacted:');
    for (const secret of [
      sentinels.enrolmentCode,
      sentinels.anthropicKey,
      sentinels.githubToken,
      enrolment.code,
    ]) {
      expect(leaked.raw).not.toContain(secret);
      expect([...out, ...err].join('\n')).not.toContain(secret);
    }
    expect(leaked.raw).not.toMatch(/tcj_[A-Za-z0-9_-]{43}/);
    expect([...out, ...err].join('\n')).not.toMatch(/tcj_[A-Za-z0-9_-]{43}/);

    // 5. Plant, then verify on `none`: hook, git config, .npmrc and a detached process do not reach the next job.
    const plantId = await runNow(SCENARIO.plant);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const plant = await readBack(plantId);
    show('plant', plant.job, plant.events);
    const summary = String(plant.job.result?.['summary']);
    expect(summary).toMatch(/^planted pid=\d+ settings-writable=false plugin-writable=false$/);
    const pid = Number(/pid=(\d+)/.exec(summary)?.[1]);
    expect(() => process.kill(pid, 0)).toThrow();
    const verifyId = await runNow(SCENARIO.verify);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const verify = await readBack(verifyId);
    show('verify', verify.job, verify.events);
    expect(verify.job).toMatchObject({ state: 'finished', result: { summary: 'clean' } });

    // 6. Usage limit: failed with reason/retryAt, a paused event, and the runner claims nothing until retryAt.
    const limitId = await runNow(SCENARIO.usageLimit);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    const limited = await readBack(limitId);
    show('usage-limit', limited.job, limited.events);
    expect(limited.job).toMatchObject({
      state: 'failed',
      result: { metrics: { reason: 'usage-limit', costUsd: 0.5, turns: 7 } },
    });
    const retryAt = (limited.job.result?.['metrics'] as Record<string, unknown> | undefined)?.['retryAt'];
    expect(limited.events.filter((event) => event.kind === 'paused').map((event) => event.payload)).toEqual([
      { reason: 'usage-limit', retryAt },
    ]);
    const waiting = await runNow(SCENARIO.ok);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    expect(out.at(-2)).toBe(`paused (usage-limit) until ${String(retryAt)}; not claiming`);
    expect((await readBack(waiting)).job.state).toBe('queued');

    // 7. #571: the pause is mirrored to the console — Settings › Runners reads it with the reason and the reset time.
    const listed = await fetch(`${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners`);
    const list: unknown = await listed.json();
    if (!isRunnerListDto(list)) {
      throw new Error('the runner list did not answer a RunnerListDto');
    }
    const mirrored = list.runners.find((runner) => runner.id === enrolled.runnerId);
    console.info(`[pause] runner ${enrolled.runnerId} pause=${JSON.stringify(mirrored?.pause)}`);
    expect(mirrored?.pause).toEqual({ reason: 'usage-limit', until: retryAt });
    expect(err).toEqual([]);
  }, 120_000);
});
