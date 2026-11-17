import { readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isResolvedTeamConfig, type JobDto, type ResolvedTeamConfigDto } from '@shared/contracts';
import { NoneBackend } from '../backends/none';
import type { RunnerConfig } from '../config/config';
import { JobRegistry } from '../proxy/job-registry';
import { jobFixture, sentinels } from '../testing/fake-console';
import { SCENARIO, makeRunnerHome, recordingConsole, runnerConfigFor } from '../testing/job-fixture';
import { runJob, type JobRunDeps } from './run-job';

/**
 * The launch from the claim's resolved team configuration (ADR 0009 d.5, d.6, d.10; #685; threat model T5, T7, T11):
 * the console's own `claim.with-config` fixture is fed to `runJob` against the `none` backend and the fake CLI, which
 * reports the argv, the settings file, the env's names and the clone's shape it was started with.
 */

const CLAIM_FIXTURE = resolve(import.meta.dirname, '../../../api/fixtures/team-config/claim.with-config.json');

interface ClaimFixture {
  readonly response: { readonly body: { readonly job: JobDto; readonly teamConfig: ResolvedTeamConfigDto } };
}

const claim = JSON.parse(readFileSync(CLAIM_FIXTURE, 'utf8')) as ClaimFixture;

const REMOVE = Symbol('remove');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A deep copy of the fixture's view with the member at `path` set (or removed): the fixture itself never changes. */
function viewWith(path: string, value: unknown): unknown {
  const view: unknown = JSON.parse(JSON.stringify(claim.response.body.teamConfig));
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  let at: unknown = view;
  for (const key of keys) {
    at = isObject(at) ? at[key] : undefined;
  }
  if (!isObject(at)) {
    throw new Error(`no member ${path} in the fixture`);
  }
  if (value === REMOVE) {
    delete at[last];
  } else {
    at[last] = value;
  }
  return view;
}

interface LaunchReport {
  readonly model: string | null;
  readonly maxTurns: string | null;
  readonly settings: Record<string, unknown> | null;
  readonly envNames: readonly string[];
  readonly shallow: boolean;
  readonly promisor: string | null;
  readonly readme: boolean;
  readonly prompt: string;
}

describe('runJob with the claim’s team configuration (#685)', () => {
  let fixture: Awaited<ReturnType<typeof makeRunnerHome>>;
  let logs: string[];

  beforeEach(async () => {
    fixture = await makeRunnerHome();
    logs = [];
  });

  afterEach(async () => {
    await fixture.done();
  });

  const apiKeyCredential = { kind: 'api-key' as const, file: 'credentials/anthropic.key' };

  async function plantApiKey(): Promise<void> {
    await mkdir(join(fixture.home, 'credentials'), { mode: 0o700 });
    await writeFile(join(fixture.home, 'credentials', 'anthropic.key'), sentinels.anthropicKey, { mode: 0o600 });
  }

  function depsFor(client: ReturnType<typeof recordingConsole>, config: RunnerConfig): JobRunDeps {
    return {
      home: fixture.home,
      config,
      client,
      backend: new NoneBackend(fixture.home),
      registry: new JobRegistry(),
      sourceEnv: { PATH: process.env['PATH'], ANTHROPIC_API_KEY: sentinels.anthropicKey },
      log: (line) => logs.push(line),
      now: () => new Date(),
      shutdown: new AbortController().signal,
      limitStreak: 0,
      flushMs: 20,
    };
  }

  async function launch(
    teamConfig: unknown,
    options: { readonly role?: string; readonly credential?: boolean } = {},
  ): Promise<{ client: ReturnType<typeof recordingConsole>; report: LaunchReport | null; result: string }> {
    if (options.credential !== false) {
      await plantApiKey();
    }
    const client = recordingConsole();
    const config = runnerConfigFor(fixture.repo, options.credential === false ? {} : { credential: apiKeyCredential });
    const job = jobFixture({ items: [SCENARIO.launch], ...(options.role === undefined ? {} : { role: options.role }) });
    const outcome = await runJob(job, sentinels.jobToken, depsFor(client, config), teamConfig);
    const finished = client.finished[0];
    return {
      client,
      result: outcome.result,
      report: finished?.result === 'finished' ? (JSON.parse(finished.summary) as LaunchReport) : null,
    };
  }

  const teamNoticeOf = (client: ReturnType<typeof recordingConsole>) =>
    client.sent.find((event) => event.kind === 'notice' && 'cost' in event.payload)?.payload;

  it('feeds a fixture the shared guard accepts', () => {
    expect(isResolvedTeamConfig(claim.response.body.teamConfig)).toBe(true);
  });

  it('launches with the view’s model, turn limit and effort, as separate argv elements', async () => {
    const { client, report } = await launch(claim.response.body.teamConfig);
    const orchestrator = claim.response.body.teamConfig.roles.orchestrator;
    expect(report).toMatchObject({ model: orchestrator.model, maxTurns: String(orchestrator.max_turns) });
    expect(report?.settings).toEqual({
      disableAllHooks: true,
      env: { DISABLE_AUTOUPDATER: '1' },
      effortLevel: orchestrator.effort,
    });
    expect(client.finished[0]?.metrics).toMatchObject({
      exitCode: 0,
      total_cost_usd: 0.0123,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 800,
    });
  }, 30_000);

  it('emits the cost.* status event for the job, enums and numbers only', async () => {
    const { client } = await launch(claim.response.body.teamConfig);
    expect(teamNoticeOf(client)).toEqual({
      teamConfig: {
        revision: 1,
        source: 'api_key',
        model: 'claude-sonnet-5',
        maxTurns: 400,
        effort: 'medium',
        clone: 'full',
      },
      cost: { prompt_caching: 'applied', batch_api: 'off', reviewer_context: 'not-applicable' },
    });
  }, 30_000);

  it('turns prompt caching off only when the api_key project says so, and reports batch_api unsupported', async () => {
    const { client, report } = await launch(
      viewWith('cost', { prompt_caching: false, batch_api: true, reviewer_context: 'repo' }),
    );
    expect(report?.settings).toMatchObject({ env: { DISABLE_AUTOUPDATER: '1', DISABLE_PROMPT_CACHING: '1' } });
    expect(teamNoticeOf(client)?.['cost']).toEqual({
      prompt_caching: 'off',
      batch_api: 'unsupported',
      reviewer_context: 'off',
    });
  }, 30_000);

  it('runs a claim without a view on ROLE_MODELS, without a turn limit or effort (an older console)', async () => {
    const { client, report } = await launch(undefined, { credential: false });
    expect(report).toMatchObject({ model: 'claude-opus-5-5', maxTurns: null });
    expect(report?.settings).toEqual({ disableAllHooks: true, env: { DISABLE_AUTOUPDATER: '1' } });
    expect(teamNoticeOf(client)).toEqual({
      teamConfig: { view: 'absent', model: 'claude-opus-5-5' },
      cost: { prompt_caching: 'not-applied', batch_api: 'not-applied', reviewer_context: 'not-applied' },
    });
  }, 30_000);

  describe('T5: a view the shared guard refuses never launches', () => {
    const marker = (): string => join(fixture.root, 'cli-started');

    async function refusedWith(teamConfig: unknown): Promise<ReturnType<typeof recordingConsole>> {
      await plantApiKey();
      const cli = join(fixture.root, 'cli.sh');
      await writeFile(cli, `#!/bin/sh\ntouch ${marker()}\n`);
      await chmod(cli, 0o755);
      const client = recordingConsole();
      const config = runnerConfigFor(fixture.repo, {
        credential: apiKeyCredential,
        toolchain: { path: '/usr/bin:/bin', claude: cli },
      });
      const report = await runJob(jobFixture({ items: [SCENARIO.launch] }), sentinels.jobToken, depsFor(client, config), teamConfig);
      expect(report).toMatchObject({ result: 'failed', reason: 'team-config-invalid' });
      expect(client.finished[0]).toMatchObject({ result: 'failed', metrics: { reason: 'team-config-invalid' } });
      expect(client.sent).toContainEqual(
        expect.objectContaining({ kind: 'notice', payload: expect.objectContaining({ refused: 'team-config-invalid' }) }),
      );
      await expect(readdir(fixture.root)).resolves.not.toContain('cli-started');
      return client;
    }

    it('a model outside the allow-list, shaped as a second flag', async () => {
      const injected = 'claude-opus-5-5 --dangerously-skip-permissions';
      const client = await refusedWith(viewWith('roles.orchestrator.model', injected));
      const wire = JSON.stringify([client.sent, client.finished]);
      expect(wire).not.toContain('--dangerously-skip-permissions');
    });

    it.each<[string, string, unknown]>([
      ['an alias', 'roles.orchestrator.model', 'opus'],
      ['Fable for security', 'roles.security.model', 'claude-fable-5-1'],
      ['a turn limit past its bound', 'roles.orchestrator.max_turns', 1001],
      ['a numeric string turn limit', 'roles.orchestrator.max_turns', '400'],
      ['an effort outside the enum', 'roles.orchestrator.effort', 'max'],
      ['an unknown member', 'budget', { monthly_usd: 400 }],
      ['a missing role', 'roles.reviewer', REMOVE],
      ['another schema', 'schema', 'team-config/v2'],
      ['an unknown access source', 'access.source', 'oauth'],
    ])('%s', async (_label, path, value) => {
      await refusedWith(viewWith(path, value));
    });

    it.each([null, 'team-config/v1', [], 42])('a view that is not an object (%j)', async (value) => {
      await refusedWith(value);
    });
  });

  describe('T7: the credential kind must match access.source', () => {
    it('subscription with an api-key credential is refused by kind name only (sentinel)', async () => {
      const { client, result } = await launch(viewWith('access.source', 'subscription'));
      expect(result).toBe('failed');
      expect(client.finished[0]?.metrics).toMatchObject({ reason: 'credential-source-mismatch' });
      const refusal = client.sent.find((event) => event.payload['refused'] === 'credential-source-mismatch');
      expect(refusal?.payload['detail']).toBe("the api-key credential does not match the project's subscription access source");
      const everything = JSON.stringify([client.sent, client.finished, logs]);
      expect(everything).not.toContain(sentinels.anthropicKey);
    }, 30_000);

    it('api_key without a credential is refused: the host’s Claude login never runs a BYOK project', async () => {
      const { client } = await launch(claim.response.body.teamConfig, { credential: false });
      expect(client.finished[0]?.metrics).toMatchObject({ reason: 'credential-source-mismatch' });
    }, 30_000);

    it('api_key launches with the key and no Claude login variable', async () => {
      const { report } = await launch(claim.response.body.teamConfig);
      expect(report?.envNames).toContain('ANTHROPIC_API_KEY');
      expect(report?.envNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(report?.envNames).not.toContain('CLAUDE_CONFIG_DIR');
    }, 30_000);

    it('subscription on the host’s own sign-in launches with no API-account variable', async () => {
      const { report } = await launch(viewWith('access.source', 'subscription'), {
        credential: false,
      });
      for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
        expect(report?.envNames).not.toContain(name);
      }
    }, 30_000);
  });

  describe('T11: reviewer_context diff narrows the reviewer’s clone only', () => {
    it('a reviewer job gets a blob-less, one-commit clone and the status says applied', async () => {
      const { client, report } = await launch(claim.response.body.teamConfig, { role: 'reviewer' });
      expect(report).toMatchObject({ shallow: true, promisor: 'true', readme: true, model: 'claude-sonnet-5' });
      expect(teamNoticeOf(client)).toMatchObject({
        teamConfig: { clone: 'diff' },
        cost: { reviewer_context: 'applied' },
      });
    }, 30_000);

    it.each(['security', 'qa'])('a %s job always gets the full clone', async (role) => {
      const { client, report } = await launch(claim.response.body.teamConfig, { role });
      expect(report).toMatchObject({ shallow: false, promisor: null, readme: true });
      expect(teamNoticeOf(client)).toMatchObject({
        teamConfig: { clone: 'full' },
        cost: { reviewer_context: 'not-applicable' },
      });
    }, 30_000);

    it('a reviewer on a subscription project gets the full clone: the levers apply under api_key only', async () => {
      const { client, report } = await launch(viewWith('access.source', 'subscription'), {
        role: 'reviewer',
        credential: false,
      });
      expect(report).toMatchObject({ shallow: false, promisor: null });
      expect(teamNoticeOf(client)?.['cost']).toEqual({
        prompt_caching: 'not-applied',
        batch_api: 'not-applied',
        reviewer_context: 'not-applied',
      });
    }, 30_000);
  });
});
