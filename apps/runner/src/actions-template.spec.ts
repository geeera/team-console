import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import {
  CONSOLE_AUDIENCE_PLACEHOLDER,
  CONSOLE_URL_PLACEHOLDER,
  isConsoleOrigin,
  renderRunnerWorkflow,
} from '@shared/actions-workflow';
import {
  ACTIONS_ENVIRONMENT,
  ACTIONS_WORKFLOW_FILE,
  attestationVerifyArgs,
  isUlid,
  releaseDownloadArgs,
  tarballNameOf,
} from '@shared/contracts';
import { ACTIONS_RUN_ENV, REQUEST_TOKEN_STDIN } from './cli/run-once-oidc';
import { INFERENCE_API_KEY_ENV } from './env/credential';

/**
 * The customer's workflow file (#671, #712; ADR 0008 decision 7(a′), threat model C11). Each control the console and
 * the threat model rely on is asserted here on the parsed template and on every rendering the console serves (#759),
 * so an edit that loosens one fails CI.
 */

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly 'runs-on'?: unknown;
  readonly environment?: unknown;
  readonly permissions?: unknown;
  readonly 'timeout-minutes'?: unknown;
  readonly steps?: readonly Step[];
  readonly services?: unknown;
  readonly container?: unknown;
}

interface Workflow {
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, Job>>;
}

const app = join(import.meta.dirname, '..');
const templatePath = join(app, 'templates', 'team-console-runner.yml');
const templateText = readFileSync(templatePath, 'utf8');

/**
 * What a run of the file sees: the template with its two placeholders, and the console's rendering for every deployed
 * environment (#759, security note PR 2), with the origin and the environment each one has in apps/api/wrangler.jsonc.
 */
interface Subject {
  readonly label: string;
  readonly text: string;
  readonly consoleUrl: string;
  readonly audience: string;
}

function configuredConsoles(): { readonly environment: string; readonly origin: string }[] {
  const config = readFileSync(join(app, '..', 'api', 'wrangler.jsonc'), 'utf8');
  const environments = [...config.matchAll(/"ENVIRONMENT": "([a-z]+)"/g)].map((match) => match[1] ?? '');
  const origins = [...config.matchAll(/"CONSOLE_PUBLIC_ORIGIN": "([^"]*)"/g)].map((match) => match[1] ?? '');
  if (environments.join() !== 'dev,stage,production' || origins.length !== environments.length) {
    throw new Error('apps/api/wrangler.jsonc must name ENVIRONMENT and CONSOLE_PUBLIC_ORIGIN once per deployed env');
  }
  return environments.map((environment, index) => ({ environment, origin: origins[index] ?? '' }));
}

const CONSOLES = configuredConsoles();
const RENDERINGS: readonly Subject[] = await Promise.all(
  CONSOLES.map(async ({ environment, origin }): Promise<Subject> => {
    const outcome = await renderRunnerWorkflow({ consoleOrigin: origin, environment });
    if (!outcome.ok) {
      throw new Error(`the ${environment} console renders no workflow: ${outcome.failure}`);
    }
    const { text, audience } = outcome.rendering;
    return { label: `the ${environment} rendering`, text, consoleUrl: origin, audience };
  }),
);
const SUBJECTS: readonly Subject[] = [
  { label: 'the template', text: templateText, consoleUrl: CONSOLE_URL_PLACEHOLDER, audience: CONSOLE_AUDIENCE_PLACEHOLDER },
  ...RENDERINGS,
];

const envOf = (step: Step): Readonly<Record<string, unknown>> => step.env ?? {};
const runOf = (step: Step): string => step.run ?? '';

function stepsOf(text: string): readonly Step[] {
  const workflow = parse(text) as Workflow;
  return Object.values(workflow.jobs ?? {})[0]?.steps ?? [];
}

function stepIn(steps: readonly Step[], name: string): Step {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`the workflow has no step "${name}"`);
  }
  return step;
}

/** The one line of `run` that starts with `prefix`, split into words with their quotes removed. */
function commandWords(run: string, prefix: string): string[] {
  const line = run.split('\n').find((candidate) => candidate.trim().startsWith(prefix));
  if (line === undefined) {
    throw new Error(`no "${prefix}" line`);
  }
  return line
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^"(.*)"$/, '$1'));
}

function expand(word: string, values: Readonly<Record<string, string>>): string {
  return word.replace(/\$\{([A-Za-z_]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

const ULID_CHECK = /\[\[ ! "\$\{JOB_ID\}" =~ (\S+) \]\]/;

describe.each(SUBJECTS)('apps/runner/templates/team-console-runner.yml, $label', (subject) => {
  const { text } = subject;
  const workflow = parse(text) as Workflow;
  const jobs = Object.values(workflow.jobs ?? {});
  const job: Job = jobs[0] ?? {};
  const steps: readonly Step[] = job.steps ?? [];
  const stepNamed = (name: string): Step => stepIn(steps, name);
  const indexOf = (name: string): number => steps.findIndex((step) => step.name === name);

  it('is the workflow file the console verifies the token against', () => {
    expect(basename(templatePath)).toBe(ACTIONS_WORKFLOW_FILE);
  });

  it('runs on workflow_dispatch only, with the single input job_id', () => {
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: { job_id: { description: expect.any(String), required: true, type: 'string' } },
      },
    });
  });

  it('holds contents: read and id-token: write and nothing else, at the workflow level only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(jobs.map((candidate) => candidate.permissions)).toEqual([undefined]);
  });

  it('is one job in the team-console Environment on a GitHub-hosted runner', () => {
    expect(jobs).toHaveLength(1);
    expect(job.environment).toBe(ACTIONS_ENVIRONMENT);
    expect(job['runs-on']).toMatch(/^ubuntu-\d\d\.\d\d$/);
    expect(job.container).toBeUndefined();
    expect(job.services).toBeUndefined();
    expect(job['timeout-minutes']).toBe(360);
  });

  it('uses no action at all: no actions/checkout, no actions/cache, no artifact upload (#712)', () => {
    // A JavaScript action gets ACTIONS_RUNTIME_TOKEN, and its post step would run after the job from files the job
    // can change; with no `uses:` that token never reaches a process the job can influence. This is stricter than a
    // SHA pin and `persist-credentials: false`: there is no action to pin and no checkout to persist anything.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((step) => step.uses !== undefined)).toEqual([]);
    expect(steps.filter((step) => step.with !== undefined)).toEqual([]);
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/actions\/(cache|checkout|upload-artifact|download-artifact)/);
    expect(code).not.toMatch(/^\s*-?\s*uses:/m);
  });

  it('never interpolates an expression into a script: the job id and every secret come through env:', () => {
    for (const step of steps) {
      expect(runOf(step)).not.toContain('${{');
    }
    const expressions = [...text.matchAll(/\$\{\{[^}]*\}\}/g)].map((match) => match[0]);
    expect(new Set(expressions)).toEqual(
      new Set([
        '${{ inputs.job_id }}',
        '${{ github.token }}',
        `\${{ secrets.${INFERENCE_API_KEY_ENV} }}`,
      ]),
    );
    // #759: no Actions variable at all; the console's origin and audience are literals of the rendering.
    expect(text).not.toContain('${{ vars.');
  });

  it('checks the job id against the ULID pattern first, read from env:', () => {
    expect(indexOf('Check the job id')).toBe(0);
    const check = stepNamed('Check the job id');
    expect(envOf(check)).toEqual({ JOB_ID: '${{ inputs.job_id }}' });
    const pattern = ULID_CHECK.exec(runOf(check))?.[1];
    expect(pattern).toBeDefined();
    const ulid = new RegExp(pattern ?? '$^');
    for (const candidate of ['01KA0000000000000000000J01', '01ARZ3NDEKTSV4RRFFQ69G5FAV']) {
      expect(isUlid(candidate)).toBe(true);
      expect(ulid.test(candidate)).toBe(true);
    }
    for (const candidate of ['01ka0000000000000000000j01', '01KA0000000000000000000J0', '01KA0000000000000000000JI1', '$(id)', '']) {
      expect(isUlid(candidate)).toBe(false);
      expect(ulid.test(candidate)).toBe(false);
    }
  });

  describe('root is given up before anything third-party runs (#712)', () => {
    const drop = (): string => runOf(stepNamed('Give up root for the rest of the run'));

    it('drops every sudo rule, the Docker socket and ptrace of other processes', () => {
      const script = drop();
      expect(script).toContain('sudo sysctl -q -w kernel.yama.ptrace_scope=2');
      expect(script).toContain('sudo systemctl stop "${unit}"');
      expect(script).toContain('for unit in docker.socket docker.service; do');
      expect(script).toContain('sudo rm -f /var/run/docker.sock /run/docker.sock');
      expect(script).toContain('printf "%s\\n" "Defaults env_reset" "root ALL=(ALL:ALL) ALL" > /etc/sudoers.team-console');
      expect(script).toContain('visudo -cq -f /etc/sudoers.team-console');
      expect(script).toContain('rm -rf /etc/sudoers.d');
      expect(script).toContain('mv -f /etc/sudoers.team-console /etc/sudoers');
      // The new sudoers is checked before the old rules go, so a broken file never replaces them half-way.
      expect(script.indexOf('visudo -cq')).toBeLessThan(script.indexOf('rm -rf /etc/sudoers.d'));
      expect(script.indexOf('rm -rf /etc/sudoers.d')).toBeLessThan(script.indexOf('mv -f /etc/sudoers.team-console'));
    });

    it('asserts right after that sudo, the socket and ptrace are gone', () => {
      expect(indexOf('Check that root is gone')).toBe(indexOf('Give up root for the rest of the run') + 1);
      const check = runOf(stepNamed('Check that root is gone'));
      expect(check).toContain('if sudo -n true 2> /dev/null; then');
      expect(check).toContain('if [[ -e /var/run/docker.sock || -e /run/docker.sock ]]; then');
      expect(check).toContain('if [[ "$(cat /proc/sys/kernel/yama/ptrace_scope)" != 2 ]]; then');
      expect(check).toContain('if [[ "$(id -u)" == 0 ]]; then');
    });

    it('comes right after the job id check, before every download and the job', () => {
      const dropAt = indexOf('Give up root for the rest of the run');
      expect(dropAt).toBe(1);
      for (const name of ['Install Node.js', 'Download and verify the runner', 'Install the Claude Code CLI', 'Run the job']) {
        expect(indexOf(name)).toBeGreaterThan(indexOf('Check that root is gone'));
      }
      // No step after the check asks for root again.
      for (const step of steps.slice(indexOf('Check that root is gone') + 1)) {
        expect(runOf(step)).not.toMatch(/\bsudo\b/);
      }
    });
  });

  describe('the runner release', () => {
    const step = (): Step => stepNamed('Download and verify the runner');
    const version = (): string => String(envOf(step())['RUNNER_VERSION']);

    it('is pinned to one release version', () => {
      expect(version()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(runOf(step())).toContain('tarball="team-console-runner-${RUNNER_VERSION}-linux-x64.tar.gz"');
      expect(expand('team-console-runner-${RUNNER_VERSION}-linux-x64.tar.gz', { RUNNER_VERSION: version() })).toBe(
        tarballNameOf(version(), 'linux-x64'),
      );
    });

    it('is downloaded and verified with exactly the flags of the release identity in @shared/contracts', () => {
      const values = { RUNNER_VERSION: version(), download: '<download>', tarball: tarballNameOf(version(), 'linux-x64') };
      const verify = commandWords(runOf(step()), 'gh attestation verify').map((word) => expand(word, values));
      expect(verify).toEqual(['gh', ...attestationVerifyArgs(`<download>/${values.tarball}`, version())]);
      const download = commandWords(runOf(step()), 'gh release download').map((word) => expand(word, values));
      expect(download).toEqual(['gh', ...releaseDownloadArgs(version(), values.tarball, '<download>')]);
    });

    it('is extracted only after the attestation check, then checked against its own SHA256SUMS', () => {
      const run = runOf(step());
      expect(run.indexOf('gh attestation verify')).toBeLessThan(run.indexOf('tar -xzf'));
      expect(run).toContain('sha256sum --check --strict --quiet SHA256SUMS');
      expect(run.indexOf('tar -xzf')).toBeLessThan(run.indexOf('sha256sum --check'));
      expect(run).toContain('set -euo pipefail');
    });
  });

  it('pins Node.js 22 (the bundle’s target) by checksum', () => {
    const step = stepNamed('Install Node.js');
    expect(String(envOf(step)['NODE_VERSION'])).toMatch(/^22\.\d+\.\d+$/);
    expect(String(envOf(step)['NODE_SHA256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(app, '..', '..', '.nvmrc'), 'utf8').trim()).toBe('22');
    const run = runOf(step);
    expect(run).toContain('sha256sum --check --strict --quiet');
    expect(run.indexOf('sha256sum --check')).toBeLessThan(run.indexOf('tar -xJf'));
  });

  it('pins the Claude Code CLI to the runner image’s version, by checksum, without npm install scripts', () => {
    const step = stepNamed('Install the Claude Code CLI');
    const dockerfile = readFileSync(join(app, 'Dockerfile'), 'utf8');
    const imageVersion = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(envOf(step)['CLAUDE_CODE_VERSION']).toBe(imageVersion);
    expect(String(envOf(step)['CLAUDE_CODE_SHA512'])).toMatch(/^[0-9a-f]{128}$/);
    const run = runOf(step);
    expect(run).toContain('sha512sum --check --strict --quiet');
    expect(run.indexOf('sha512sum --check')).toBeLessThan(run.indexOf('tar -xzf'));
    expect(run).not.toMatch(/\bnpm\b|\bnpx\b/);
  });

  describe('the job step', () => {
    const step = (): Step => stepNamed('Run the job');

    it('is the last step, so nothing runs on the VM after the job', () => {
      expect(indexOf('Run the job')).toBe(steps.length - 1);
    });

    it('passes exactly the variables run-once --oidc reads, the key from the Environment secret', () => {
      expect(envOf(step())).toEqual({
        [ACTIONS_RUN_ENV.jobId]: '${{ inputs.job_id }}',
        [ACTIONS_RUN_ENV.consoleUrl]: subject.consoleUrl,
        [ACTIONS_RUN_ENV.audience]: subject.audience,
        [INFERENCE_API_KEY_ENV]: `\${{ secrets.${INFERENCE_API_KEY_ENV} }}`,
        [ACTIONS_RUN_ENV.readToken]: '${{ github.token }}',
      });
      expect(runOf(step())).toContain(`export ${ACTIONS_RUN_ENV.claude}="\${RUNNER_TEMP}/claude-code/claude"`);
    });

    it('masks the key as defence in depth', () => {
      expect(runOf(step())).toContain('echo "::add-mask::${TC_INFERENCE_API_KEY}"');
    });

    it('hands the request token over on stdin and removes it from the environment of the runner it execs (#712)', () => {
      const run = runOf(step());
      expect(run).toContain(
        `exec env -u ${ACTIONS_RUN_ENV.idTokenToken} NODE_OPTIONS=--disable-sigusr1 PATH="\${RUNNER_TEMP}/node/bin:/usr/bin:/bin" \\`,
      );
      expect(run).toContain(`run-once --oidc --request-token ${REQUEST_TOKEN_STDIN} \\`);
      expect(run).toContain(`<<< "\${${ACTIONS_RUN_ENV.idTokenToken}}"`);
      // The token appears nowhere else in the step: not exported, not on an argument list.
      expect(run.split(ACTIONS_RUN_ENV.idTokenToken)).toHaveLength(4);
    });

    it('starts the runner with SIGUSR1 off, so the job cannot open its Node inspector (#712)', () => {
      // The job runs as the runner's uid: `kill -USR1` would otherwise open the inspector on 127.0.0.1:9229, and
      // `Runtime.evaluate` would read the request token and the job's console identity out of the runner.
      const run = runOf(step());
      expect(run).toMatch(/^\s*exec env -u \S+ NODE_OPTIONS=--disable-sigusr1 /m);
      // Nothing else in the step sets NODE_OPTIONS or an inspector flag.
      expect(run.match(/NODE_OPTIONS/g)).toHaveLength(1);
      expect(run).not.toMatch(/--inspect/);
      expect(text).not.toMatch(/--inspect/);
    });
  });

});

it('the launcher in the release starts node with SIGUSR1 off as well, whatever NODE_OPTIONS holds', () => {
  const launcher = readFileSync(join(app, 'bin', 'team-console-runner'), 'utf8');
  const execs = launcher.split('\n').filter((line) => /^\s*exec /.test(line));
  // One exec, whichever node the launcher picked (launcher.spec.ts covers the choice).
  expect(execs).toEqual(['exec "$node" --disable-sigusr1 "$bundle" "$@"']);
  expect(launcher).not.toMatch(/--inspect/);
});

describe('the console’s renderings of the template (#759, security note PR 2)', () => {
  const verifyLineOf = (text: string): string =>
    runOf(stepIn(stepsOf(text), 'Download and verify the runner'))
      .split('\n')
      .find((line) => line.trim().startsWith('gh attestation verify')) ?? '';

  it('holds each placeholder once, as the job step’s two values, inside quotes', () => {
    for (const placeholder of [CONSOLE_URL_PLACEHOLDER, CONSOLE_AUDIENCE_PLACEHOLDER]) {
      expect(templateText.split(placeholder)).toHaveLength(2);
    }
    expect(templateText.split('__TC_')).toHaveLength(3);
    expect(templateText).toContain(`${ACTIONS_RUN_ENV.consoleUrl}: '${CONSOLE_URL_PLACEHOLDER}'\n`);
    expect(templateText).toContain(`${ACTIONS_RUN_ENV.audience}: '${CONSOLE_AUDIENCE_PLACEHOLDER}'\n`);
  });

  it('renders for every deployed console, from its configured https origin and its own audience', () => {
    expect(RENDERINGS.map((rendering) => rendering.audience)).toEqual(
      CONSOLES.map(({ environment }) => `team-console:${environment}`),
    );
    for (const { origin } of CONSOLES) {
      expect(isConsoleOrigin(origin)).toBe(true);
    }
    for (const rendering of RENDERINGS) {
      expect(rendering.text).not.toContain('__TC_');
    }
  });

  it('keeps the gh attestation verify flags byte for byte in every rendering, so no console moves the trust root', () => {
    const template = verifyLineOf(templateText);
    expect(template).toContain('--signer-workflow github.com/geeera/team-console/.github/workflows/release-runner.yml');
    for (const rendering of RENDERINGS) {
      expect(verifyLineOf(rendering.text)).toBe(template);
    }
  });

  it('differs from the template in the two literal lines only', () => {
    const before = templateText.split('\n');
    for (const rendering of RENDERINGS) {
      const after = rendering.text.split('\n');
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, index) => line !== before[index])).toEqual([
        `          ${ACTIONS_RUN_ENV.consoleUrl}: '${rendering.consoleUrl}'`,
        `          ${ACTIONS_RUN_ENV.audience}: '${rendering.audience}'`,
      ]);
    }
  });
});
