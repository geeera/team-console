import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunnerConfig, saveRunnerConfig, type RunnerConfig } from '../config/config';
import type { EnrolOptions } from '../cli/enrol';
import { ACCOUNT_ID, RUNNER_ID } from '../testing/fake-console';
import {
  enrolmentOf,
  runContainerSetup,
  type ContainerSetupDeps,
  type ContainerSetupOptions,
} from './container-setup';
import type { RunnerHalfReport } from './self-check';
import { SetupError } from './setup';

/**
 * The Linux setup in the runner's container (#634 PR 7, R-LNX): enrol by the request id in `TC_ENROLMENT` for the
 * container backend on rootless podman, then the API key at its hidden prompt, then the console's answer.
 */

const INTENT = '01JD0000000000000000000000';
const IMAGE = `ghcr.io/geeera/team-console-runner:0.2.0@sha256:${'e'.repeat(64)}`;
const URL = 'https://console.example';

const enrolledConfig = (overrides: Partial<RunnerConfig> = {}): RunnerConfig => ({
  schema: 1,
  apiUrl: URL,
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  name: 'build box',
  audience: 'team-console:dev',
  projectScope: 'all',
  allowedProjects: [],
  pollSeconds: 60,
  backend: 'container',
  credential: { kind: 'api-key', file: 'credentials/anthropic.key' },
  container: { image: IMAGE },
  ...overrides,
});

const accepted: RunnerHalfReport = {
  version: '0.2.0',
  failure: null,
  config: null,
  self: { belowMinimum: false, pausedUntil: null, projects: [] },
};

describe('setup in the runner’s container (Linux)', () => {
  let home: string;
  let out: string[];
  let enrolled: EnrolOptions[];
  let keys: boolean[];
  let report: RunnerHalfReport;

  const options = (overrides: Partial<ContainerSetupOptions> = {}): ContainerSetupOptions => ({
    url: URL,
    enrolment: INTENT,
    image: IMAGE,
    replaceCredential: false,
    ...overrides,
  });
  const deps = (overrides: Partial<ContainerSetupDeps> = {}): ContainerSetupDeps => ({
    home,
    uid: 990,
    out: (line) => out.push(line),
    enrol: async (given) => {
      enrolled.push(given);
      const config = enrolledConfig();
      await saveRunnerConfig(home, config);
      return config;
    },
    setUpApiKey: async (_config, replace) => {
      keys.push(replace);
      await mkdir(join(home, 'credentials'), { recursive: true, mode: 0o700 });
      await writeFile(join(home, 'credentials', 'anthropic.key'), 'sk-ant-api03-x\n', { mode: 0o600 });
    },
    runnerHalf: async () => report,
    ...overrides,
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'tcr-linux-'));
    out = [];
    enrolled = [];
    keys = [];
    report = accepted;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('enrols the container backend with an API key and the named image, then sets podman and asks for the key', async () => {
    expect(await runContainerSetup(options(), deps())).toBe(true);
    expect(enrolled).toEqual([
      { url: URL, enrolment: INTENT, backend: 'container', credential: 'api-key', image: IMAGE },
    ]);
    expect((await loadRunnerConfig(home)).container).toEqual({ image: IMAGE, runtime: 'podman' });
    expect(keys).toEqual([false]);
    expect(out.at(-1)).toBe(
      'Готово: раннер «build box» принят консолью; team-console-runner.service запускается следующей командой.',
    );
  });

  it('is safe to run again: an enrolled home and a present key are kept', async () => {
    await runContainerSetup(options(), deps());
    enrolled = [];
    keys = [];
    expect(await runContainerSetup(options(), deps())).toBe(true);
    expect(enrolled).toEqual([]);
    expect(keys).toEqual([]);
    expect(out).toContain(`enrol: already enrolled as «build box»; TC_ENROLMENT is not used`);
    expect(out).toContain(
      'credential: credentials/anthropic.key is present and kept (--replace-credential to replace it)',
    );
  });

  it('replaces the key only when asked', async () => {
    await runContainerSetup(options(), deps());
    keys = [];
    await runContainerSetup(options({ replaceCredential: true }), deps());
    expect(keys).toEqual([true]);
  });

  it('refuses root, before anything is enrolled', async () => {
    await expect(runContainerSetup(options(), deps({ uid: 0 }))).rejects.toThrow(/never as root/);
    expect(enrolled).toEqual([]);
  });

  it.each([
    ['no image', { image: undefined }],
    ['an image by tag', { image: 'ghcr.io/geeera/team-console-runner:0.2.0' }],
    ['an http console', { url: 'http://console.example' }],
  ])('refuses %s before anything is enrolled', async (_, overrides) => {
    await expect(runContainerSetup(options(overrides), deps())).rejects.toThrow(SetupError);
    expect(enrolled).toEqual([]);
  });

  it('needs the request id for a new runner', async () => {
    await expect(runContainerSetup(options({ enrolment: undefined }), deps())).rejects.toThrow(
      /TC_ENROLMENT=<request id>/,
    );
  });

  it('moves an enrolled runner’s jobs to the image of a new release’s command', async () => {
    const old = `ghcr.io/geeera/team-console-runner:0.2.0@sha256:${'f'.repeat(64)}`;
    await saveRunnerConfig(home, enrolledConfig({ container: { image: old, runtime: 'podman' } }));
    expect(await runContainerSetup(options(), deps())).toBe(true);
    expect((await loadRunnerConfig(home)).container).toEqual({ image: IMAGE, runtime: 'podman' });
    expect(out).toContain(`config: jobs now run from ${IMAGE} (was ${old})`);
    expect(enrolled).toEqual([]);
  });

  const { credential: _credential, container: _container, ...bare } = enrolledConfig();
  it.each<[string, RunnerConfig, RegExp]>([
    [
      'another console',
      enrolledConfig({ apiUrl: 'https://other.example' }),
      /enrolled with https:\/\/other\.example/,
    ],
    ['another backend', { ...bare, backend: 'none' }, /holds a none runner/],
  ])('refuses a home enrolled with %s', async (_, config, reason) => {
    await saveRunnerConfig(home, config);
    await expect(runContainerSetup(options(), deps())).rejects.toThrow(reason);
    expect(enrolled).toEqual([]);
    expect(keys).toEqual([]);
  });

  it('fails with the console’s reason when the new key is not accepted', async () => {
    report = { ...accepted, failure: { stage: 'identity', message: 'the runner is revoked' }, self: null };
    expect(await runContainerSetup(options(), deps())).toBe(false);
    expect(out.at(-1)).toBe('check: identity: the runner is revoked');
  });

  it('fails when the image is below the console’s minimum', async () => {
    report = { ...accepted, self: { belowMinimum: true, pausedUntil: null, projects: [] } };
    expect(await runContainerSetup(options(), deps())).toBe(false);
  });
});

describe('enrolmentOf', () => {
  it('takes the flag first, then TC_ENROLMENT, and treats an empty variable as none', () => {
    expect(enrolmentOf('A', { TC_ENROLMENT: 'B' })).toBe('A');
    expect(enrolmentOf(undefined, { TC_ENROLMENT: 'B' })).toBe('B');
    expect(enrolmentOf(undefined, { TC_ENROLMENT: '' })).toBeUndefined();
    expect(enrolmentOf(undefined, {})).toBeUndefined();
  });
});
