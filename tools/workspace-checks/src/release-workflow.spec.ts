import { workspaceRoot } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * `release-runner.yml` (#572; SECURITY follow-ups on #603, #604): the `release` environment gates every job, not only
 * the build, and a job that runs third-party install scripts can reach no publishing credential — `build` holds only
 * `contents: read`, and `image`'s Docker build (which runs the Dockerfile's `npm ci`) is handed no secret or agent.
 */

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly environment?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

function readJobs(): Readonly<Record<string, Job>> {
  const workflow: unknown = parse(readFileSync(join(workspaceRoot, '.github/workflows/release-runner.yml'), 'utf8'));
  if (typeof workflow !== 'object' || workflow === null || !('jobs' in workflow)) {
    throw new Error('release-runner.yml has no jobs');
  }
  return workflow.jobs as Readonly<Record<string, Job>>;
}

const jobs = readJobs();

describe('release-runner.yml', () => {
  it.each(Object.keys(jobs))('runs %s in the release environment', (name) => {
    expect(jobs[name]?.environment).toBe('release');
  });

  it('gives a job that runs npm ci on the runner nothing but contents: read', () => {
    const installers = Object.entries(jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) => /\bnpm (ci|install)\b/.test(step.run ?? '')),
    );
    expect(installers.map(([name]) => name)).toEqual(['build']);
    for (const [, job] of installers) {
      expect(job.permissions).toEqual({ contents: 'read' });
    }
  });

  it('hands the image build no secret, ssh agent or token', () => {
    const builds = Object.values(jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.uses?.startsWith('docker/build-push-action@') === true),
    );
    expect(builds).toHaveLength(1);
    const inputs = builds[0]?.with ?? {};
    for (const input of ['secrets', 'secret-files', 'secret-envs', 'ssh', 'github-token']) {
      expect(inputs).not.toHaveProperty(input);
    }
    expect(JSON.stringify(inputs)).not.toMatch(/github\.token|secrets\./);
  });
});
