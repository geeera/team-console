import { isAccessSource, type AccessSource } from '@shared/contracts';
import { JOB_USER, RUNNER_HOME_MODE, RUNNER_USER, SYSTEM_MANAGED_SETTINGS_PATH, managedSettingsText } from '../backends/user';
import { CREDENTIAL_BACKENDS, SOURCE_CREDENTIAL_KINDS, type CredentialKind } from '../env/credential';
import { InstallError, assertRootOwnedPrefix, type InstallHost } from '../install/install';
import { LAUNCH_LABEL, jobExecOf } from '../install/templates';
import { RUNNER_VERSION } from '../version';
import { judgeCandidate, ownerWarningOf, type Tool } from './toolchain';

/**
 * `team-console-runner self-check` (#634 PR 2, architect note section 5): what `setup` ends with, runnable alone as
 * root. Each check prints `ok`, `warn` or `FAIL` with the one thing to do, and the run ends with one «Готово» line or
 * the count of failures. Root reads modes, owners and sizes only: the runner's own half (`self-check --runner-half`,
 * as `_tcrunner`) loads the config and the key and asks the console; the credential's value is never opened, its size
 * stands for its length. L3 checks 5–7 need a running job and stay in the runbook's manual check.
 */

/** The host `setup` and `self-check` run on, as root. */
export interface SetupHost extends InstallHost {
  /** Runs this runner's CLI as `_tcrunner` with an empty environment and the terminal's stdio; root sees the exit code only. */
  runAsRunner(args: readonly string[]): Promise<number>;
  /** The same, with stdout captured: for the runner half's report, which holds no secret. */
  queryAsRunner(args: readonly string[]): Promise<{ code: number | null; stdout: string }>;
  /** Directory entries, or `null` when the path is not a directory. */
  list(path: string): Promise<readonly string[] | null>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface RunnerHalfReport {
  readonly version: string;
  readonly failure: { readonly stage: 'config' | 'key' | 'identity'; readonly message: string } | null;
  readonly config: {
    readonly name: string;
    readonly backend: string;
    readonly credential: { readonly kind: CredentialKind; readonly file: string | null } | null;
    readonly toolchain: { readonly path: string; readonly claude: string | null } | null;
  } | null;
  readonly self: {
    readonly belowMinimum: boolean;
    readonly pausedUntil: string | null;
    readonly projects: readonly { readonly slug: string; readonly accessSource: AccessSource }[];
  } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const CREDENTIAL_KINDS: readonly string[] = Object.keys(CREDENTIAL_BACKENDS);

/** Narrows the runner half's one JSON line; anything else is a failed check, never trusted. */
export function parseRunnerHalfReport(text: string): RunnerHalfReport | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    // Not JSON: the half crashed or printed something else.
    return null;
  }
  if (!isRecord(value) || typeof value['version'] !== 'string') {
    return null;
  }
  const { failure, config, self } = value;
  const failureOk =
    failure === null ||
    (isRecord(failure) &&
      ['config', 'key', 'identity'].includes(failure['stage'] as string) &&
      typeof failure['message'] === 'string');
  const credential = isRecord(config) ? config['credential'] : null;
  const toolchain = isRecord(config) ? config['toolchain'] : null;
  const configOk =
    config === null ||
    (isRecord(config) &&
      typeof config['name'] === 'string' &&
      typeof config['backend'] === 'string' &&
      (credential === null ||
        (isRecord(credential) &&
          CREDENTIAL_KINDS.includes(credential['kind'] as string) &&
          (credential['file'] === null || typeof credential['file'] === 'string'))) &&
      (toolchain === null ||
        (isRecord(toolchain) &&
          typeof toolchain['path'] === 'string' &&
          (toolchain['claude'] === null || typeof toolchain['claude'] === 'string'))));
  const selfOk =
    self === null ||
    (isRecord(self) &&
      typeof self['belowMinimum'] === 'boolean' &&
      (self['pausedUntil'] === null || typeof self['pausedUntil'] === 'string') &&
      Array.isArray(self['projects']) &&
      self['projects'].every(
        (project: unknown) => isRecord(project) && typeof project['slug'] === 'string' && isAccessSource(project['accessSource']),
      ));
  return failureOk && configOk && selfOk ? (value as unknown as RunnerHalfReport) : null;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckLine {
  readonly status: CheckStatus;
  readonly label: string;
  readonly detail: string;
}

export interface SelfCheckContext {
  readonly home: string;
  readonly prefix: string;
  readonly out: (line: string) => void;
  /** How long the service must keep one pid to count as up past its first claim. */
  readonly settleMs: number;
}

const DSCL = '/usr/bin/dscl';
const DSEDITGROUP = '/usr/sbin/dseditgroup';
const SUDO = '/usr/bin/sudo';
const LAUNCHCTL = '/bin/launchctl';
const CREDENTIAL_MIN_BYTES = 9;
const CREDENTIAL_MAX_BYTES = 4097;

const ok = (label: string, detail = ''): CheckLine => ({ status: 'ok', label, detail });
const warn = (label: string, detail: string): CheckLine => ({ status: 'warn', label, detail });
const fail = (label: string, detail: string): CheckLine => ({ status: 'fail', label, detail });

async function uidOf(host: SetupHost, user: string): Promise<number | null> {
  const { code, stdout } = await host.exec('/usr/bin/id', ['-u', user]);
  return code === 0 && /^\d+$/.test(stdout.trim()) ? Number(stdout.trim()) : null;
}

async function runnerHalf(host: SetupHost): Promise<RunnerHalfReport | null> {
  const { code, stdout } = await host.queryAsRunner(['self-check', '--runner-half']);
  return code === null ? null : parseRunnerHalfReport(stdout);
}

function identityLines(report: RunnerHalfReport | null): CheckLine[] {
  if (report === null) {
    return [fail('config and key', `the runner's own check as ${RUNNER_USER} gave no answer; run it by hand: sudo -u ${RUNNER_USER} … self-check --runner-half`)];
  }
  const { failure } = report;
  if (failure?.stage === 'config' || failure?.stage === 'key') {
    return [fail('config and key', `${failure.message} (run setup --only enrol, or see docs/runbooks/runner.md)`)];
  }
  const lines = [ok('config and key', `runner «${report.config?.name ?? '?'}», ${report.config?.backend ?? '?'} backend`)];
  if (failure !== null || report.self === null) {
    lines.push(fail('identity', `the console refused this runner's key: ${failure?.message ?? 'no answer'}`));
    return lines;
  }
  if (report.self.belowMinimum) {
    lines.push(fail('identity', `this runner (${report.version}) is below the console's minimum version: update it`));
  } else {
    lines.push(ok('identity', 'the console accepts this runner\'s key'));
  }
  return lines;
}

/** `launchctl print` names the service running with a pid; the same pid after `settleMs` means it stayed up. */
async function serviceLine(host: SetupHost, settleMs: number): Promise<CheckLine> {
  const label = 'service';
  const pidOf = async (): Promise<string | null> => {
    const { code, stdout } = await host.exec(LAUNCHCTL, ['print', `system/${LAUNCH_LABEL}`]);
    if (code !== 0 || !/^\s*state = running\s*$/m.test(stdout)) {
      return null;
    }
    return /^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1] ?? null;
  };
  const first = await pidOf();
  if (first === null) {
    return fail(label, `${LAUNCH_LABEL} is not running: sudo launchctl bootstrap system /Library/LaunchDaemons/${LAUNCH_LABEL}.plist, then see logs/runner.log`);
  }
  await host.sleep(settleMs);
  const second = await pidOf();
  if (second !== first) {
    return fail(label, `${LAUNCH_LABEL} keeps restarting (pid ${first} → ${second ?? 'none'}): see <home>/logs/runner.log`);
  }
  return ok(label, `running as pid ${first}, up past its first claim`);
}

async function credentialLines(
  host: SetupHost,
  home: string,
  report: RunnerHalfReport | null,
  runnerUid: number | null,
): Promise<CheckLine[]> {
  const label = 'credential';
  const credential = report?.config?.credential ?? null;
  const projects = report?.self?.projects ?? [];
  const kind = credential?.kind ?? null;
  const lines: CheckLine[] = [];
  if (credential === null) {
    lines.push(warn(label, 'none configured: jobs fall back to the host\'s own Claude sign-in (setup --only credential)'));
  } else if (credential.file !== null) {
    const path = `${home}/${credential.file}`;
    const facts = await host.stat(path);
    const size = facts?.size ?? null;
    if (facts === null) {
      lines.push(fail(label, `${credential.file} is missing: setup --only credential`));
    } else if (facts.kind !== 'file' || facts.uid !== runnerUid || facts.mode !== 0o600) {
      lines.push(fail(label, `${credential.file} must be a regular file of ${RUNNER_USER}, mode 0600`));
    } else if (size === null || size < CREDENTIAL_MIN_BYTES || size > CREDENTIAL_MAX_BYTES) {
      lines.push(fail(label, `${credential.file} does not hold one credential line: setup --only credential --replace`));
    } else {
      lines.push(ok(label, `${credential.kind}, present, ${String(size)} bytes`));
    }
  } else {
    lines.push(ok(label, `${credential.kind}`));
  }
  for (const project of projects) {
    const fits = kind === null ? project.accessSource === 'subscription' : SOURCE_CREDENTIAL_KINDS[project.accessSource].includes(kind);
    if (!fits) {
      lines.push(
        fail(
          'credential fit',
          `project ${project.slug} runs on ${project.accessSource}; this runner has ${kind ?? 'no credential'} (credential-source-mismatch at its first job)`,
        ),
      );
    }
  }
  return lines;
}

/** The tool as the job will find it: the configured `claude`, the first `git` and `node` on the job's PATH. */
async function toolchainLines(host: SetupHost, report: RunnerHalfReport | null): Promise<CheckLine[]> {
  const toolchain = report?.config?.toolchain ?? null;
  if (toolchain === null) {
    return [fail('toolchain', 'config.json names no toolchain: setup --only toolchain')];
  }
  const dirs = toolchain.path.split(':');
  const lines: CheckLine[] = [];
  for (const tool of ['claude', 'git', 'node'] as const satisfies readonly Tool[]) {
    const configured = tool === 'claude' && toolchain.claude?.startsWith('/') === true ? [toolchain.claude] : null;
    const candidates = configured ?? dirs.map((dir) => `${dir}/${tool === 'claude' ? (toolchain.claude ?? 'claude') : tool}`);
    let verdict: Awaited<ReturnType<typeof judgeCandidate>> = null;
    for (const candidate of candidates) {
      verdict = await judgeCandidate(host, tool, candidate);
      if (verdict !== null) {
        break;
      }
    }
    if (verdict === null) {
      lines.push(tool === 'node' ? warn(tool, 'not on the job PATH') : fail(tool, 'not found on the job PATH: setup --only toolchain'));
    } else if (typeof verdict === 'string') {
      lines.push(fail(tool, `${verdict}: setup --only toolchain`));
    } else {
      const ownerWarning = ownerWarningOf(verdict);
      lines.push(ownerWarning === null ? ok(tool, `${verdict.path}, runs as ${JOB_USER}`) : warn(tool, ownerWarning));
    }
  }
  return lines;
}

async function readAttribute(host: SetupHost, user: string, attribute: string): Promise<string | null> {
  const { code, stdout } = await host.exec(DSCL, ['.', '-read', `/Users/${user}`, attribute]);
  return code === 0 ? (new RegExp(`^${attribute}:\\s*(.+)$`, 'm').exec(stdout)?.[1]?.trim() ?? null) : null;
}

/** The rule lines of `sudo -l -U _tcrunner`, normalised. */
export function sudoRulesOf(listing: string): string[] {
  const lines = listing.split('\n');
  const start = lines.findIndex((line) => /may run the following commands/.test(line));
  if (start === -1) {
    return [];
  }
  return lines
    .slice(start + 1)
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => line.trim().replace(/\s+/g, ' '));
}

/** L3 checks 1–4 and 8, read-only. */
async function isolationLines(host: SetupHost, home: string, prefix: string, runnerUid: number | null): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const jobHome = await readAttribute(host, JOB_USER, 'NFSHomeDirectory');
  const jobShell = await readAttribute(host, JOB_USER, 'UserShell');
  lines.push(
    jobHome === '/var/empty' && jobShell === '/usr/bin/false'
      ? ok('L3-1 job user', `${JOB_USER}: home /var/empty, shell /usr/bin/false`)
      : fail('L3-1 job user', `${JOB_USER} must have home /var/empty and shell /usr/bin/false: run setup --only install`),
  );
  for (const user of [JOB_USER, RUNNER_USER]) {
    const { code } = await host.exec(DSEDITGROUP, ['-o', 'checkmember', '-m', user, 'admin']);
    if (code === 0) {
      lines.push(fail('L3-1 not admin', `${user} is in the admin group: remove it (dseditgroup -o edit -d ${user} -t user admin)`));
    }
  }

  const homeFacts = await host.stat(home);
  const dirsOk =
    homeFacts?.kind === 'directory' &&
    homeFacts.uid === runnerUid &&
    homeFacts.mode === RUNNER_HOME_MODE &&
    (await Promise.all(
      ['credentials', 'logs'].map(async (name) => {
        const facts = await host.stat(`${home}/${name}`);
        return facts?.kind === 'directory' && facts.uid === runnerUid && facts.mode === 0o700;
      }),
    )).every(Boolean);
  const links: string[] = [];
  for (const dir of [home, `${home}/credentials`, `${home}/keys`]) {
    for (const name of (await host.list(dir)) ?? []) {
      if ((await host.stat(`${dir}/${name}`))?.kind === 'symlink') {
        links.push(`${dir}/${name}`);
      }
    }
  }
  const listed = await host.exec(SUDO, ['-n', '-u', JOB_USER, '--', '/bin/ls', home]);
  lines.push(
    dirsOk && links.length === 0 && listed.code !== 0
      ? ok('L3-2 runner home', `${home} 0710, credentials and logs 0700, no links, ${JOB_USER} cannot list it`)
      : fail(
          'L3-2 runner home',
          links.length > 0
            ? `symlinks where none belong (${links.join(', ')}): check who put them there, remove them`
            : listed.code === 0
              ? `${JOB_USER} can list ${home}: chmod 0710 it`
              : `${home} must be ${RUNNER_USER}'s 0710, credentials and logs 0700: run setup --only install`,
        ),
  );

  const settingsPath = SYSTEM_MANAGED_SETTINGS_PATH.darwin;
  const settings = await host.stat(settingsPath);
  lines.push(
    settings?.kind === 'file' && settings.uid === 0 && settings.mode === 0o644 && (await host.read(settingsPath)) === managedSettingsText()
      ? ok('L3-3 managed settings', 'root-owned 0644, as the installer wrote them')
      : fail('L3-3 managed settings', `${settingsPath} differs from the installer's: run setup --only install`),
  );

  const rules = sudoRulesOf((await host.exec(SUDO, ['-n', '-l', '-U', RUNNER_USER])).stdout);
  const expected = `(${JOB_USER}) NOPASSWD: ${jobExecOf(prefix)}`;
  lines.push(
    rules.length === 1 && rules[0] === expected
      ? ok('L3-4 sudoers', `exactly one rule: ${expected}`)
      : fail('L3-4 sudoers', `${RUNNER_USER} must have exactly the rule "${expected}" (found ${String(rules.length)}): check /etc/sudoers.d`),
  );

  try {
    await assertRootOwnedPrefix(host, prefix);
    lines.push(ok('L3-8 release files', `${prefix} root-owned, writable by root only`));
  } catch (error: unknown) {
    if (!(error instanceof InstallError)) {
      throw error;
    }
    lines.push(fail('L3-8 release files', error.message));
  }
  return lines;
}

const MARKS: Readonly<Record<CheckStatus, string>> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** Runs every check, prints each, and answers whether none failed. */
export async function selfCheck(host: SetupHost, context: SelfCheckContext): Promise<boolean> {
  const { home, prefix, out } = context;
  const runnerUid = await uidOf(host, RUNNER_USER);
  const report = await runnerHalf(host);
  const lines: CheckLine[] = [...identityLines(report)];
  if (report !== null && report.version !== RUNNER_VERSION) {
    lines.push(fail('L3-8 release files', `the installed bundle reports ${report.version}, this setup is ${RUNNER_VERSION}`));
  }
  lines.push(await serviceLine(host, context.settleMs));
  lines.push(...(await credentialLines(host, home, report, runnerUid)));
  lines.push(...(await toolchainLines(host, report)));
  lines.push(...(await isolationLines(host, home, prefix, runnerUid)));
  for (const line of lines) {
    out(`${MARKS[line.status]} ${line.label}${line.detail === '' ? '' : `: ${line.detail}`}`);
  }
  const failed = lines.filter((line) => line.status === 'fail');
  if (failed.length === 0) {
    out(`Готово: раннер «${report?.config?.name ?? ''}» на связи.`);
    return true;
  }
  out(`Not ready: ${String(failed.length)} check(s) failed; the first to fix: ${failed[0]?.label ?? ''}.`);
  return false;
}
