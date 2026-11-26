import { renderRunnerWorkflow, type RunnerWorkflowRendering } from '@shared/actions-workflow';
import { ACTIONS_WORKFLOW_PR_KINDS } from '@shared/contracts';
import { planWorkflowPr } from './workflow-pr';
import { workflowCommitMessageOf, workflowPrBodyOf, workflowPrTitleOf } from './workflow-pr-text';

// #759 PR 4: what the console writes into a customer repository besides the file (security note row "Workflow content
// steered by input"), and which pull request the file on the default branch calls for.

let rendering: RunnerWorkflowRendering;

beforeAll(async () => {
  const rendered = await renderRunnerWorkflow({
    consoleOrigin: 'https://console.example.com',
    environment: 'dev',
  });
  if (!rendered.ok) {
    throw new Error(rendered.failure);
  }
  rendering = rendered.rendering;
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('the pull request’s text', () => {
  it.each(ACTIONS_WORKFLOW_PR_KINDS)(
    'holds no @ and nothing but constants, pins and the sha256 for a %s',
    (kind) => {
      const hostile = { runner: '1.0.0 @admin', node: '${{ secrets.X }}', claudeCode: '<script>' };
      const text = [
        workflowPrTitleOf(kind, rendering),
        workflowPrBodyOf(kind, rendering, hostile),
        workflowCommitMessageOf(kind, rendering),
      ].join('\n');
      expect(text).not.toContain('@');
      expect(text).not.toContain('admin');
      expect(text).not.toContain('secrets.');
      expect(text).not.toContain('<script>');
      expect(text).toContain(rendering.sha256);
    },
  );

  it('lists the three pins old → new with where to check each', () => {
    const body = workflowPrBodyOf('bump', rendering, {
      runner: '0.0.1',
      node: rendering.pins.node,
      claudeCode: null,
    });
    expect(body).toContain(`| Team Console runner | 0.0.1 → ${rendering.pins.runner} |`);
    expect(body).toContain(`| Node.js | ${rendering.pins.node} (unchanged) |`);
    expect(body).toContain(`| Claude Code CLI | ${rendering.pins.claudeCode} |`);
    expect(body).toContain(`https://nodejs.org/dist/v${rendering.pins.node}/SHASUMS256.txt`);
    expect(body).toContain(`/releases/tag/v${rendering.pins.runner}`);
    expect(body).toContain('Team Console never merges it');
  });

  it('links the runner release of the repository the workflow itself verifies the tarball against', () => {
    const repository = /--repo (\S+) --signer-workflow/.exec(rendering.text)?.[1];
    expect(repository).toBeDefined();
    expect(workflowPrBodyOf('setup', rendering, null)).toContain(
      `https://github.com/${String(repository)}/releases/tag/v${rendering.pins.runner}`,
    );
  });
});

describe('planWorkflowPr', () => {
  const pinned = (name: string, version: string): string =>
    rendering.text.replace(new RegExp(`(${name}: )\\d+\\.\\d+\\.\\d+`), `$1${version}`);

  it('is a setup without a file, and nothing when the file is the rendering', () => {
    expect(planWorkflowPr({ kind: 'missing' }, rendering)).toEqual({
      outcome: 'plan',
      plan: { kind: 'setup', current: null },
    });
    expect(planWorkflowPr({ kind: 'file', bytes: bytes(rendering.text) }, rendering)).toEqual({
      outcome: 'already-current',
    });
  });

  it('is a bump when a pin rises, a restore when none does', () => {
    expect(
      planWorkflowPr({ kind: 'file', bytes: bytes(pinned('NODE_VERSION', '20.0.0')) }, rendering),
    ).toMatchObject({
      outcome: 'plan',
      plan: { kind: 'bump' },
    });
    expect(
      planWorkflowPr({ kind: 'file', bytes: bytes(`${rendering.text}# edited\n`) }, rendering),
    ).toMatchObject({
      outcome: 'plan',
      plan: { kind: 'restore' },
    });
    expect(planWorkflowPr({ kind: 'file', bytes: bytes('not a workflow') }, rendering)).toMatchObject({
      plan: { kind: 'restore' },
    });
    expect(planWorkflowPr({ kind: 'too-large' }, rendering)).toMatchObject({
      plan: { kind: 'restore', current: null },
    });
  });

  it('refuses a file that pins anything higher, even when another pin would rise', () => {
    const mixed = pinned('NODE_VERSION', '20.0.0').replace(/(RUNNER_VERSION: )\d+\.\d+\.\d+/, '$1999.0.0');
    expect(planWorkflowPr({ kind: 'file', bytes: bytes(mixed) }, rendering)).toEqual({
      outcome: 'downgrade',
      pins: ['runner'],
    });
  });
});
