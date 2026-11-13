import { OWNER_ACCOUNT_ID, isProblemDetails, PROBLEM_TYPE_PREFIX, type ClaimResponse } from '@shared/contracts';
import { ApiGitHub } from '../github';
import { fetchApi } from '../testing/access-kit';
import { localEnv, stubGitHub, type StubGitHub } from '../testing/github-kit';
import { readModelGitHub } from '../testing/read-model-kit';
import { enqueueJob, enrolRunner, runnerJwt, sendAsRunner, type TestRunner } from '../testing/runner-kit';
import { seedTrackerProject } from '../testing/tracker-kit';
import {
  JOB_SPRINT_READS_PER_WINDOW,
  JOB_SPRINT_WINDOW_SECONDS,
  RUNNER_SPRINT_READS_PER_WINDOW,
} from './project-read-models';

// #546: the runner's `/sprint` cap on top of the per-job budget of #537, through real job tokens (the stand-in
// identity carries no runner).

// A project holds one job of a kind at a time, so a runner's concurrent jobs are on distinct projects.
interface Held {
  readonly runner: TestRunner;
  readonly slugs: readonly string[];
  readonly tokens: readonly string[];
  readonly jobIds: readonly string[];
}

const clock = { at: Date.now() };
let stub: StubGitHub;
let github: ApiGitHub;

beforeEach(() => {
  clock.at = Date.now();
});

async function holdJobs(count: number): Promise<Held> {
  const slugs: string[] = [];
  const repos: Record<string, { issues: never[] }> = {};
  for (let index = 0; index < count; index += 1) {
    const { slug } = await seedTrackerProject();
    slugs.push(slug);
    repos[`acme/${slug}`] = { issues: [] };
  }
  stub = stubGitHub(readModelGitHub(repos));
  github = new ApiGitHub({ fetch: stub.fetch, now: () => clock.at });
  const runner = await enrolRunner(OWNER_ACCOUNT_ID, {
    allowedProjects: slugs,
    enrol: { capabilities: { local: true, maxConcurrency: count } },
  });
  const tokens: string[] = [];
  const jobIds: string[] = [];
  for (const slug of slugs) {
    await enqueueJob(slug);
    const response = await sendAsRunner(runner, 'POST', '/api/v1/runner/jobs/claim', {});
    expect(response.status, `claim on ${slug}`).toBe(200);
    const claim = (await response.json()) as ClaimResponse;
    tokens.push(claim.jobToken);
    jobIds.push(claim.job.id);
  }
  return { runner, slugs, tokens, jobIds };
}

async function readSprint(held: Held, index: number, logSink?: (line: string) => void): Promise<Response> {
  return fetchApi(`/api/v1/projects/${held.slugs[index]}/sprint`, localEnv(), {
    github,
    headers: { Authorization: `Bearer ${held.tokens[index]}`, 'X-Runner-Jwt': await runnerJwt(held.runner) },
    ...(logSink === undefined ? {} : { logSink }),
  });
}

async function readsInTurn(held: Held, reads: number, jobs = held.tokens.length): Promise<void> {
  for (let read = 0; read < reads; read += 1) {
    const response = await readSprint(held, read % jobs);
    expect(response.status, `read ${String(read + 1)}`).toBe(200);
  }
}

describe('the runner cap on a job’s /sprint reads (#546)', () => {
  it('trips across two jobs of one runner that are each inside their own limit', async () => {
    const held = await holdJobs(2);
    expect(RUNNER_SPRINT_READS_PER_WINDOW).toBeGreaterThan(JOB_SPRINT_READS_PER_WINDOW);
    expect(RUNNER_SPRINT_READS_PER_WINDOW).toBeLessThan(2 * JOB_SPRINT_READS_PER_WINDOW);
    await readsInTurn(held, RUNNER_SPRINT_READS_PER_WINDOW);

    const callsBefore = stub.calls.length;
    const refused = await readSprint(held, 1);
    expect(refused.status).toBe(429);
    const body: unknown = await refused.json();
    expect(isProblemDetails(body) && body.type === `${PROBLEM_TYPE_PREFIX}rate-limited`).toBe(true);
    const atSeconds = Math.floor(clock.at / 1000);
    expect(Number(refused.headers.get('Retry-After'))).toBe(
      JOB_SPRINT_WINDOW_SECONDS - (atSeconds % JOB_SPRINT_WINDOW_SECONDS),
    );
    expect(stub.calls).toHaveLength(callsBefore);
  });

  // #555: the capped-runner warning must carry `runnerId` alongside `jobId`, so a capped runner can be
  // identified without a join against the job it tripped on.
  it('logs the runner cap trip with both jobId and runnerId', async () => {
    const held = await holdJobs(2);
    await readsInTurn(held, RUNNER_SPRINT_READS_PER_WINDOW);

    const lines: string[] = [];
    const refused = await readSprint(held, 1, (line) => lines.push(line));
    expect(refused.status).toBe(429);

    const warning = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['message'] === 'runner sprint budget exhausted');
    expect(warning).toMatchObject({
      level: 'warn',
      jobId: held.jobIds[1],
      runnerId: held.runner.id,
    });
  });

  it('admits the runner again in the next window', async () => {
    const held = await holdJobs(2);
    await readsInTurn(held, RUNNER_SPRINT_READS_PER_WINDOW);
    expect((await readSprint(held, 0)).status).toBe(429);
    clock.at += JOB_SPRINT_WINDOW_SECONDS * 1000;
    expect((await readSprint(held, 0)).status).toBe(200);
  });

  it('leaves the jobs of another runner alone', async () => {
    const busy = await holdJobs(2);
    await readsInTurn(busy, RUNNER_SPRINT_READS_PER_WINDOW);
    expect((await readSprint(busy, 0)).status).toBe(429);
    const other = await holdJobs(1);
    expect((await readSprint(other, 0)).status).toBe(200);
  });

  it('still holds the per-job limit for a runner far under its own cap', async () => {
    const held = await holdJobs(1);
    await readsInTurn(held, JOB_SPRINT_READS_PER_WINDOW);
    expect((await readSprint(held, 0)).status).toBe(429);
  });

  it('does not charge the runner for reads its job already lost to the per-job limit', async () => {
    const held = await holdJobs(2);
    await readsInTurn(held, JOB_SPRINT_READS_PER_WINDOW, 1);
    for (let refused = 0; refused < 5; refused += 1) {
      expect((await readSprint(held, 0)).status).toBe(429);
    }
    // Runner count is 10; the second job still has the 5 reads left under the cap.
    for (let read = 0; read < RUNNER_SPRINT_READS_PER_WINDOW - JOB_SPRINT_READS_PER_WINDOW; read += 1) {
      expect((await readSprint(held, 1)).status, `read ${String(read + 1)}`).toBe(200);
    }
    expect((await readSprint(held, 1)).status).toBe(429);
  });
});
