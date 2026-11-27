import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_ACCOUNT_ID,
  isEnrolmentCodeDto,
  isRunnerCheckDto,
  type RunnerCheckDto,
} from '@shared/contracts';
import { EXIT_OK, runCli } from '../cli/cli';
import { configPathOf, loadRunnerConfig } from '../config/config';
import { writePrivateFile } from '../config/private-files';
import { removeTree } from '../git/workspace';
import { sentinels } from '../testing/fake-console';
import { runnerConfigFor } from '../testing/job-fixture';
import { startLocalStack, type LocalStack } from '../testing/local-stack';

/**
 * #1059 end to end: the api Worker on a fresh local D1 (PR 1's routes), the real runner CLI — `enrol --backend none`,
 * then `run-once` — and the fake Claude CLI's `--version`. The owner starts a check on Settings › Runners' route, the
 * runner's next poll picks it up and reports it, and the owner reads it back as the wizard will.
 */

const OWNER_HEADERS = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

describe('integration: «Проверить» → runner check → report', () => {
  let stack: LocalStack;
  let home: string;
  const out: string[] = [];
  const err: string[] = [];

  const cli = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<number> =>
    runCli(args, {
      env: { TC_RUNNER_HOME: home, PATH: process.env['PATH'], ...env },
      homeDir: home,
      host: { os: process.platform, arch: process.arch, hostname: 'integration.local' },
      fetch: (url, init) => fetch(url, init),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });

  const checksOf = (runnerId: string): string =>
    `${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runnerId}/checks`;

  async function startCheck(runnerId: string): Promise<RunnerCheckDto> {
    const response = await fetch(checksOf(runnerId), {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ kind: 'smoke' }),
    });
    const text = await response.text();
    console.info(`[start] POST …/checks → ${String(response.status)} ${text}`);
    expect(response.status, text).toBe(201);
    const check: unknown = JSON.parse(text);
    if (!isRunnerCheckDto(check)) {
      throw new Error('the start did not answer a RunnerCheckDto');
    }
    return check;
  }

  async function readCheck(runnerId: string, checkId: string): Promise<RunnerCheckDto> {
    const response = await fetch(`${checksOf(runnerId)}/${checkId}`);
    const text = await response.text();
    console.info(`[read] GET …/checks/${checkId} → ${String(response.status)} ${text}`);
    const check: unknown = JSON.parse(text);
    if (!isRunnerCheckDto(check)) {
      throw new Error('the read did not answer a RunnerCheckDto');
    }
    return check;
  }

  beforeAll(async () => {
    stack = await startLocalStack(94);
    home = await mkdtemp(join(tmpdir(), 'r-'));
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
    await removeTree(home);
  }, 30_000);

  it('the owner starts a check, run-once runs claude --version and the console reads back passed', async () => {
    const code = await fetch(`${stack.origin}/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/enrolment-code`, {
      method: 'POST',
      headers: OWNER_HEADERS,
      body: JSON.stringify({ name: 'Check runner', projectScope: 'all', allowedProjects: [] }),
    });
    const enrolment: unknown = await code.json();
    if (!isEnrolmentCodeDto(enrolment)) {
      throw new Error('no enrolment code');
    }
    expect(
      await cli(['enrol', '--url', enrolment.apiUrl, '--backend', 'none'], { TC_ENROL_CODE: enrolment.code }),
    ).toBe(EXIT_OK);
    const enrolled = await loadRunnerConfig(home);
    const { toolchain } = runnerConfigFor('/nonexistent');
    await mkdir(join(home, 'credentials'), { mode: 0o700 });
    await writeFile(join(home, 'credentials', 'anthropic.key'), `${sentinels.anthropicKey}\n`, {
      mode: 0o600,
    });
    await rm(configPathOf(home));
    await writePrivateFile(
      configPathOf(home),
      JSON.stringify({
        ...enrolled,
        toolchain,
        credential: { kind: 'api-key', file: 'credentials/anthropic.key' },
      }),
    );

    // An idle poll declares `checks: ['smoke']`, which is what lets the owner start one (else runner-outdated).
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    expect(out.at(-1)).toBe('No job is queued for this runner.');

    const check = await startCheck(enrolled.runnerId);
    expect(check).toMatchObject({ kind: 'smoke', state: 'queued' });
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    console.info(`[runner] ${out.join('\n[runner] ')}`);
    expect(out).toContain(`claimed check ${check.id} (smoke)`);
    expect(
      out.some((line) =>
        new RegExp(`^check ${check.id} smoke: passed \\(claude 2\\.1\\.3, \\d+ ms\\)$`).test(line),
      ),
    ).toBe(true);

    const passed = await readCheck(enrolled.runnerId, check.id);
    expect(passed).toMatchObject({ id: check.id, state: 'passed', reason: null, claudeVersion: '2.1.3' });

    // Without a credential the next check fails with the reason code alone.
    const bare = { ...enrolled, toolchain };
    await rm(configPathOf(home));
    await writePrivateFile(configPathOf(home), JSON.stringify(bare));
    const second = await startCheck(enrolled.runnerId);
    expect(await cli(['run-once'])).toBe(EXIT_OK);
    expect(await readCheck(enrolled.runnerId, second.id)).toMatchObject({
      state: 'failed',
      reason: 'credential-missing',
      claudeVersion: null,
    });

    expect([...out, ...err].join('\n')).not.toContain(sentinels.anthropicKey);
    expect(err).toEqual([]);
  }, 120_000);
});
