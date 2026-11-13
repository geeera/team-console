import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FinishJobInput, JobEventInput, PauseRunnerInput } from '@shared/contracts';
import type { RunnerConfig } from '../config/config';
import { removeTree } from '../git/workspace';
import type { JobConsole } from '../jobs/run-job';
import { ACCOUNT_ID, RUNNER_ID } from './fake-console';

/** The fake CLI of decision 13; scenarios by the first item number (see the file). */
export const CLAUDE_FAKE = resolve(import.meta.dirname, '../../fixtures/claude-fake.mjs');
export const SCENARIO = {
  ok: 1,
  sentinel: 2,
  plant: 3,
  verify: 4,
  usageLimit: 5,
  rateLimit: 6,
  hang: 7,
  crash: 8,
} as const;

/** Git for fixtures only: no system or global config of the machine running the specs. */
export function fixtureGit(args: readonly string[], cwd?: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {
      cwd,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).toString();
}

/** A repository with the vendored plugin in `.claude/product-team`, as a product repository has it. */
export function makeFixtureRepo(dir: string): string {
  mkdirSync(join(dir, '.claude', 'product-team', 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'product-team', 'README.md'), 'plugin\n');
  writeFileSync(join(dir, '.claude', 'product-team', 'scripts', 'pr'), '#!/bin/sh\necho pr\n');
  chmodSync(join(dir, '.claude', 'product-team', 'scripts', 'pr'), 0o755);
  writeFileSync(join(dir, 'README.md'), 'product\n');
  fixtureGit(['init', '-q', '-b', 'main', dir]);
  fixtureGit(['add', '.'], dir);
  fixtureGit(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

/** A short temp root: the socket path `jobs/<id>/sock/tc.sock` under it must fit `sun_path`. */
export async function makeRunnerHome(): Promise<{
  root: string;
  home: string;
  repo: string;
  done: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'r-'));
  // The root is the runner home itself (mkdtemp makes it 0700); one more level would overflow `sun_path` on macOS.
  const home = root;
  const repo = makeFixtureRepo(join(root, 'repo'));
  return { root, home, repo, done: () => removeTree(root) };
}

export function runnerConfigFor(repo: string, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    schema: 1,
    apiUrl: 'https://console.example',
    runnerId: RUNNER_ID,
    accountId: ACCOUNT_ID,
    name: 'Spec runner',
    audience: 'team-console:dev',
    allowedProjects: ['team-console'],
    pollSeconds: 60,
    backend: 'none',
    toolchain: { path: `${dirname(process.execPath)}:/usr/bin:/bin`, claude: CLAUDE_FAKE },
    repositories: { 'team-console': repo },
    ...overrides,
  };
}

/** The console as the job loop sees it, recording what it was sent. */
export function recordingConsole(): JobConsole & {
  sent: JobEventInput[];
  finished: FinishJobInput[];
  heartbeats: number;
  onFinish: (() => void) | null;
  /** What the loop mirrored to the console (#571), in order: a pause, or `'resume'`. */
  pauses: (PauseRunnerInput | 'resume')[];
  pause(input: PauseRunnerInput): Promise<void>;
  resume(): Promise<void>;
} {
  const fake = {
    sent: [] as JobEventInput[],
    finished: [] as FinishJobInput[],
    heartbeats: 0,
    onFinish: null as (() => void) | null,
    pauses: [] as (PauseRunnerInput | 'resume')[],
    pause: async (input: PauseRunnerInput) => {
      fake.pauses.push(input);
    },
    resume: async () => {
      fake.pauses.push('resume');
    },
    events: async (_jobId: string, events: readonly JobEventInput[]) => {
      if (events.length > 50) {
        throw new Error('a batch over 50 events');
      }
      fake.sent.push(...events);
      return { lastSeq: fake.sent.length, capped: false };
    },
    heartbeat: async () => {
      fake.heartbeats += 1;
      return { leaseUntil: new Date(Date.now() + 300_000).toISOString() };
    },
    finish: async (_jobId: string, input: FinishJobInput) => {
      fake.onFinish?.();
      fake.finished.push(input);
    },
    forwardForProject: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }),
    forwardForRunnerJob: async () => ({ status: 201, headers: {}, body: Buffer.from('{}') }),
  };
  return fake;
}
