import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { ENVIRONMENTS } from '@shared/contracts';
import {
  CONSOLE_AUDIENCE_PLACEHOLDER,
  CONSOLE_URL_PLACEHOLDER,
  isConsoleOrigin,
  renderRunnerWorkflow,
  renderTemplate,
  type RunnerWorkflowOutcome,
  type RunnerWorkflowRendering,
} from './render';
import { RUNNER_WORKFLOW_TEMPLATE } from './template.generated';

const ORIGIN = 'https://team-console-dev.geeera.workers.dev';

interface Step {
  readonly name?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

function renderedOf(outcome: RunnerWorkflowOutcome): RunnerWorkflowRendering {
  if (!outcome.ok) {
    throw new Error(`not rendered: ${outcome.failure}`);
  }
  return outcome.rendering;
}

function runStepEnv(text: string): Readonly<Record<string, unknown>> {
  const workflow = parse(text) as { jobs: Record<string, { steps: Step[] }> };
  const steps = Object.values(workflow.jobs)[0]?.steps ?? [];
  return steps.find((step) => step.name === 'Run the job')?.env ?? {};
}

describe('renderRunnerWorkflow', () => {
  it.each(ENVIRONMENTS)(
    'bakes the origin and team-console:%s in as literals, nothing else changes',
    async (environment) => {
      const rendering = renderedOf(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment }));
      expect(rendering.audience).toBe(`team-console:${environment}`);
      expect(rendering.consoleOrigin).toBe(ORIGIN);
      const env = runStepEnv(rendering.text);
      expect(env['TC_CONSOLE_URL']).toBe(ORIGIN);
      expect(env['TC_CONSOLE_AUDIENCE']).toBe(`team-console:${environment}`);
      expect(rendering.text).not.toContain('__TC_');
      expect(rendering.text).not.toContain('${{ vars.');

      const before = RUNNER_WORKFLOW_TEMPLATE.split('\n');
      const after = rendering.text.split('\n');
      expect(after).toHaveLength(before.length);
      const changed = after.filter((line, index) => line !== before[index]);
      expect(changed).toEqual([
        `          TC_CONSOLE_URL: '${ORIGIN}'`,
        `          TC_CONSOLE_AUDIENCE: 'team-console:${environment}'`,
      ]);
    },
  );

  it('names the SHA-256 of the text and the three pins of the template', async () => {
    const rendering = renderedOf(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment: 'dev' }));
    expect(rendering.sha256).toBe(createHash('sha256').update(rendering.text, 'utf8').digest('hex'));
    expect(rendering.pins.runner).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rendering.pins.node).toMatch(/^22\.\d+\.\d+$/);
    expect(rendering.pins.claudeCode).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rendering.text).toContain(`RUNNER_VERSION: ${rendering.pins.runner}\n`);
  });

  it('renders the same bytes every time, and other bytes for another console', async () => {
    const first = renderedOf(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment: 'dev' }));
    const again = renderedOf(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment: 'dev' }));
    const stage = renderedOf(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment: 'stage' }));
    expect(again.sha256).toBe(first.sha256);
    expect(stage.sha256).not.toBe(first.sha256);
  });

  describe('refuses an origin that could leave its YAML scalar or carry an expression', () => {
    const refused = [
      '',
      'http://team-console-dev.geeera.workers.dev',
      'https://localhost',
      'https://team-console-dev.geeera.workers.dev/',
      'https://team-console-dev.geeera.workers.dev/api',
      'https://team-console-dev.geeera.workers.dev:443',
      'https://team-console-dev.geeera.workers.dev?x=1',
      'https://team-console-dev.geeera.workers.dev#x',
      'https://user@team-console-dev.geeera.workers.dev',
      'https://Team-Console.example.com',
      "https://evil.example.com'",
      "https://evil.example.com' # ",
      'https://evil.example.com"',
      'https://evil.example.com${{ secrets.TC_INFERENCE_API_KEY }}',
      'https://${{ github.token }}.example.com',
      'https://evil.example.com{x}',
      'https://evil.example.com$x',
      'https://evil.example.com x',
      'https://evil.example.com\n',
      "https://evil.example.com'\n          TC_INFERENCE_API_KEY: 'x",
      'https://evil.example.com ',
      'https://evil..example.com',
      `https://${'a'.repeat(250)}.com`,
      ' https://evil.example.com',
    ];

    it.each(refused)('%j', async (consoleOrigin) => {
      expect(isConsoleOrigin(consoleOrigin)).toBe(false);
      const outcome = await renderRunnerWorkflow({ consoleOrigin, environment: 'dev' });
      expect(outcome).toEqual({ ok: false, failure: 'console-origin-invalid', detail: expect.any(String) });
      // The refusal never echoes the configured value.
      if (!outcome.ok && consoleOrigin !== '') {
        expect(outcome.detail).not.toContain(consoleOrigin);
      }
    });

    it('accepts a plain https origin', () => {
      expect(isConsoleOrigin(ORIGIN)).toBe(true);
      expect(isConsoleOrigin('https://console.example.com')).toBe(true);
      expect(isConsoleOrigin(42)).toBe(false);
    });
  });

  it.each(['', 'qa', 'Dev', 'dev\n', 'dev ', 'team-console:dev', '__proto__'])(
    'refuses the environment %j',
    async (environment) => {
      expect(await renderRunnerWorkflow({ consoleOrigin: ORIGIN, environment })).toEqual({
        ok: false,
        failure: 'environment-invalid',
        detail: expect.any(String),
      });
    },
  );
});

describe('renderTemplate over a broken template', () => {
  const input = { consoleOrigin: ORIGIN, environment: 'dev' } as const;
  const URL_LINE = `TC_CONSOLE_URL: '${CONSOLE_URL_PLACEHOLDER}'`;

  async function failureOf(template: string): Promise<string> {
    const outcome = await renderTemplate(template, input);
    return outcome.ok ? 'rendered' : `${outcome.failure}: ${outcome.detail}`;
  }

  it('renders the bundled template', async () => {
    expect(await failureOf(RUNNER_WORKFLOW_TEMPLATE)).toBe('rendered');
  });

  it('refuses a placeholder that is missing or appears twice', async () => {
    expect(await failureOf(RUNNER_WORKFLOW_TEMPLATE.replace(CONSOLE_URL_PLACEHOLDER, 'x'))).toMatch(
      /^template-invalid: .*exactly once/,
    );
    expect(await failureOf(`${RUNNER_WORKFLOW_TEMPLATE}# ${CONSOLE_AUDIENCE_PLACEHOLDER}\n`)).toMatch(
      /^template-invalid: .*exactly once/,
    );
  });

  it('refuses an unknown placeholder', async () => {
    expect(await failureOf(`${RUNNER_WORKFLOW_TEMPLATE}# __TC_OTHER__\n`)).toMatch(
      /^template-invalid: .*does not know/,
    );
  });

  it('refuses a placeholder outside the two env values', async () => {
    const moved = RUNNER_WORKFLOW_TEMPLATE.replace(
      URL_LINE,
      `TC_CONSOLE_URL: 'https://fixed.example.com'`,
    ).replace("echo '::error::job_id is not a Team Console job id'", `echo '${CONSOLE_URL_PLACEHOLDER}'`);
    expect(await failureOf(moved)).toMatch(/^template-invalid: the placeholders must be the values/);
  });

  it('refuses a template that still reads an Actions variable', async () => {
    const withVar = RUNNER_WORKFLOW_TEMPLATE.replace(
      'GITHUB_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          if [[ ! "${TC_INFERENCE',
      'GITHUB_TOKEN: ${{ vars.SOMETHING }}\n        run: |\n          set -euo pipefail\n          if [[ ! "${TC_INFERENCE',
    );
    expect(withVar).not.toBe(RUNNER_WORKFLOW_TEMPLATE);
    expect(await failureOf(withVar)).toMatch(/^template-invalid: .*Actions variable/);
  });

  it('refuses YAML that is not plain: a duplicate key, an alias', async () => {
    expect(
      await failureOf(RUNNER_WORKFLOW_TEMPLATE.replace('name: team-console-runner\n', 'name: a\nname: b\n')),
    ).toMatch(/^template-invalid: the workflow is not plain YAML/);
    const aliased = RUNNER_WORKFLOW_TEMPLATE.replace(
      'permissions:\n  contents: read',
      'permissions: &p\n  contents: read',
    ).replace('defaults:\n', 'x-copy: *p\ndefaults:\n');
    expect(aliased).not.toBe(RUNNER_WORKFLOW_TEMPLATE);
    expect(await failureOf(aliased)).toMatch(/^template-invalid: /);
  });

  it('refuses a template whose job left the team-console Environment', async () => {
    expect(
      await failureOf(
        RUNNER_WORKFLOW_TEMPLATE.replace('    environment: team-console\n', '    environment: other\n'),
      ),
    ).toMatch(/^template-invalid: .*team-console Environment/);
  });
});
