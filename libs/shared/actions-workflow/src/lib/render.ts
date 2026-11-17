import { parseDocument } from 'yaml';
import { ACTIONS_ENVIRONMENT, isEnvironment, runnerAudienceOf, type Environment } from '@shared/contracts';
import { RUNNER_WORKFLOW_TEMPLATE } from './template.generated';

/**
 * The customer's runner workflow as this console renders it (#759; architect note §2, security note row "Workflow
 * content steered by input"). The bundled template holds two placeholders; the rendering replaces them with the
 * console's own origin and audience as YAML literals, so a repository needs no Environment variables and the file on
 * its default branch is the whole configuration. Both values come from the Worker's configuration, never from a
 * request, and the rendering is parsed again and compared with the template structurally before anyone sees it.
 */

export const CONSOLE_URL_PLACEHOLDER = '__TC_CONSOLE_URL__';
export const CONSOLE_AUDIENCE_PLACEHOLDER = '__TC_CONSOLE_AUDIENCE__';
const PLACEHOLDER_PREFIX = '__TC_';

/**
 * An `https` origin of dot-separated `[a-z0-9-]` labels and nothing else: no port, path, query, credentials, quote,
 * `$`, `{`, `#`, whitespace or newline, so the literal can neither leave its quoted YAML scalar nor carry a `${{ }}`
 * expression. (A JS `$` without the `m` flag matches the end of the input only, so a trailing newline fails too.)
 */
export const CONSOLE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** A DNS name is at most 253 characters; `https://` adds 8. */
const CONSOLE_ORIGIN_MAX_LENGTH = 261;
/** `runnerAudienceOf` over the closed environment enum, checked again on its output. */
const AUDIENCE_PATTERN = /^team-console:[a-z]+$/;

/** The step whose `env` carries the two literals; `apps/runner/src/actions-template.spec.ts` pins it as the last one. */
export const RUN_STEP_NAME = 'Run the job';
const PIN_STEPS = {
  runner: { step: 'Download and verify the runner', env: 'RUNNER_VERSION' },
  node: { step: 'Install Node.js', env: 'NODE_VERSION' },
  claudeCode: { step: 'Install the Claude Code CLI', env: 'CLAUDE_CODE_VERSION' },
} as const;
const VERSION = /^\d+\.\d+\.\d+$/;

export function isConsoleOrigin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CONSOLE_ORIGIN_MAX_LENGTH &&
    CONSOLE_ORIGIN_PATTERN.test(value)
  );
}

export interface RunnerWorkflowInput {
  /** The console's public origin from the Worker's configuration (`CONSOLE_PUBLIC_ORIGIN`). */
  readonly consoleOrigin: string;
  /** The Worker's `ENVIRONMENT`; the audience is `runnerAudienceOf` of it, the exchange's `aud`. */
  readonly environment: string;
}

/** The three versions the template pins; a bump PR (#759 PR 4) lists them old → new. */
export interface RunnerWorkflowPins {
  readonly runner: string;
  readonly node: string;
  readonly claudeCode: string;
}

export interface RunnerWorkflowRendering {
  readonly text: string;
  /** Lower-case hex SHA-256 of `text` as UTF-8: what the readiness check and the PR body name. */
  readonly sha256: string;
  readonly consoleOrigin: string;
  readonly audience: string;
  readonly pins: RunnerWorkflowPins;
}

/**
 * Why nothing was rendered. `console-origin-invalid` and `environment-invalid` are configuration errors of this
 * Worker; `template-invalid` means the bundled template broke an invariant its spec should have caught.
 */
export type RunnerWorkflowFailure = 'console-origin-invalid' | 'environment-invalid' | 'template-invalid';

export type RunnerWorkflowOutcome =
  | { readonly ok: true; readonly rendering: RunnerWorkflowRendering }
  | { readonly ok: false; readonly failure: RunnerWorkflowFailure; readonly detail: string };

/** Renders the bundled template; the template is not a parameter, so no caller can hand in another one. */
export async function renderRunnerWorkflow(input: RunnerWorkflowInput): Promise<RunnerWorkflowOutcome> {
  return renderTemplate(RUNNER_WORKFLOW_TEMPLATE, input);
}

class TemplateInvalid extends Error {
  override readonly name = 'TemplateInvalid';
}

/** Exported for the specs only (the barrel does not re-export it): the same rendering over a template they supply. */
export async function renderTemplate(
  template: string,
  input: RunnerWorkflowInput,
): Promise<RunnerWorkflowOutcome> {
  if (!isEnvironment(input.environment)) {
    return {
      ok: false,
      failure: 'environment-invalid',
      detail: 'ENVIRONMENT is not one of the console environments',
    };
  }
  const audience = runnerAudienceOf(input.environment satisfies Environment);
  if (!AUDIENCE_PATTERN.test(audience)) {
    return {
      ok: false,
      failure: 'environment-invalid',
      detail: 'the runner audience is not team-console:<environment>',
    };
  }
  if (!isConsoleOrigin(input.consoleOrigin)) {
    return {
      ok: false,
      failure: 'console-origin-invalid',
      detail: 'CONSOLE_PUBLIC_ORIGIN must be an https origin with no port, path or special characters',
    };
  }
  try {
    const text = substitute(template, input.consoleOrigin, audience);
    const pins = checkRendering(template, text, input.consoleOrigin, audience);
    return {
      ok: true,
      rendering: { text, sha256: await sha256Hex(text), consoleOrigin: input.consoleOrigin, audience, pins },
    };
  } catch (error: unknown) {
    if (error instanceof TemplateInvalid) {
      return { ok: false, failure: 'template-invalid', detail: error.message };
    }
    throw error;
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function substitute(template: string, consoleOrigin: string, audience: string): string {
  for (const placeholder of [CONSOLE_URL_PLACEHOLDER, CONSOLE_AUDIENCE_PLACEHOLDER]) {
    if (occurrences(template, placeholder) !== 1) {
      throw new TemplateInvalid(`the template must hold ${placeholder} exactly once`);
    }
  }
  if (occurrences(template, PLACEHOLDER_PREFIX) !== 2) {
    throw new TemplateInvalid(
      `the template holds a ${PLACEHOLDER_PREFIX} placeholder the renderer does not know`,
    );
  }
  // split/join, not String.replace: a replacement string would interpret `$&` and friends.
  return template
    .split(CONSOLE_URL_PLACEHOLDER)
    .join(consoleOrigin)
    .split(CONSOLE_AUDIENCE_PLACEHOLDER)
    .join(audience);
}

/**
 * The rendering is the template with exactly the two env values changed: parsed again, it must equal the parsed
 * template with those two values set, so a value cannot have become a key, a step or an expression.
 */
function checkRendering(
  template: string,
  text: string,
  consoleOrigin: string,
  audience: string,
): RunnerWorkflowPins {
  if (text.includes(PLACEHOLDER_PREFIX)) {
    throw new TemplateInvalid('a placeholder survived the rendering');
  }
  if (text.includes('${{ vars.')) {
    throw new TemplateInvalid('the rendering still reads an Actions variable');
  }
  const expected = parseStrict(template);
  const expectedEnv = runStepEnvOf(expected);
  if (
    expectedEnv['TC_CONSOLE_URL'] !== CONSOLE_URL_PLACEHOLDER ||
    expectedEnv['TC_CONSOLE_AUDIENCE'] !== CONSOLE_AUDIENCE_PLACEHOLDER
  ) {
    throw new TemplateInvalid(
      `the placeholders must be the values of TC_CONSOLE_URL and TC_CONSOLE_AUDIENCE in "${RUN_STEP_NAME}"`,
    );
  }
  expectedEnv['TC_CONSOLE_URL'] = consoleOrigin;
  expectedEnv['TC_CONSOLE_AUDIENCE'] = audience;
  const rendered = parseStrict(text);
  if (JSON.stringify(rendered) !== JSON.stringify(expected)) {
    throw new TemplateInvalid('the rendering differs from the template beyond the two values');
  }
  const renderedEnv = runStepEnvOf(rendered);
  if (renderedEnv['TC_CONSOLE_URL'] !== consoleOrigin || renderedEnv['TC_CONSOLE_AUDIENCE'] !== audience) {
    throw new TemplateInvalid('the rendered values are not the inputs');
  }
  const job = onlyJobOf(rendered);
  if (job['environment'] !== ACTIONS_ENVIRONMENT) {
    throw new TemplateInvalid(`the job must run in the ${ACTIONS_ENVIRONMENT} Environment`);
  }
  return {
    runner: pinOf(rendered, PIN_STEPS.runner),
    node: pinOf(rendered, PIN_STEPS.node),
    claudeCode: pinOf(rendered, PIN_STEPS.claudeCode),
  };
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** YAML 1.2 core schema, no tags, merge keys or aliases, unique keys; any error or warning refuses the text. */
function parseStrict(text: string): Json {
  const document = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new TemplateInvalid('the workflow is not plain YAML');
  }
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new TemplateInvalid('the workflow uses a YAML alias');
  }
  if (!isRecord(root)) {
    throw new TemplateInvalid('the workflow is not a mapping');
  }
  return root;
}

function onlyJobOf(workflow: Json): Json {
  const jobs = workflow['jobs'];
  const values = isRecord(jobs) ? Object.values(jobs) : [];
  const [job] = values;
  if (values.length !== 1 || !isRecord(job)) {
    throw new TemplateInvalid('the workflow must have exactly one job');
  }
  return job;
}

function stepsOf(workflow: Json): Json[] {
  const steps = onlyJobOf(workflow)['steps'];
  if (!Array.isArray(steps) || !steps.every(isRecord)) {
    throw new TemplateInvalid('the job has no list of steps');
  }
  return steps;
}

function stepEnvOf(workflow: Json, name: string): Json {
  const named = stepsOf(workflow).filter((step) => step['name'] === name);
  const [step] = named;
  if (named.length !== 1 || step === undefined || !isRecord(step['env'])) {
    throw new TemplateInvalid(`the job must have one step "${name}" with an env`);
  }
  return step['env'];
}

function runStepEnvOf(workflow: Json): Json {
  return stepEnvOf(workflow, RUN_STEP_NAME);
}

function pinOf(workflow: Json, pin: { readonly step: string; readonly env: string }): string {
  const value = stepEnvOf(workflow, pin.step)[pin.env];
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new TemplateInvalid(`${pin.env} in "${pin.step}" must be a pinned version`);
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
