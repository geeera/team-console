import { workspaceRoot } from '@nx/devkit';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * #142: an e2e run against a target behind Cloudflare Access (stage) holds the Access service token. Playwright traces
 * and the HTML report record request headers, and this repository is public — so a job that runs with the token
 * (or against a `BASE_URL` target, where the token belongs) never uploads an artifact. `playwright.config.ts` turns
 * traces and the HTML report off with the token as well; this check is the second lock, on the workflow side.
 */

const WORKFLOWS_DIR = join(workspaceRoot, '.github/workflows');
// A job is a run against an external target when any of these appears in it or in its workflow's `env`.
const TARGET_MARKERS = /\b(CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|BASE_URL)\b/;

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: unknown;
}

interface Job {
  readonly env?: unknown;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly env?: unknown;
  readonly jobs?: Readonly<Record<string, Job>>;
}

/** `<job>: <step>` for every artifact upload in a job that runs with the Access token or against `BASE_URL`. */
function uploadsFromTargetRuns(workflow: Workflow): string[] {
  const workflowWide = TARGET_MARKERS.test(JSON.stringify(workflow.env ?? {}));
  return Object.entries(workflow.jobs ?? {}).flatMap(([id, job]) => {
    if (!workflowWide && !TARGET_MARKERS.test(JSON.stringify(job))) {
      return [];
    }
    return (job.steps ?? [])
      .filter((step) => (step.uses ?? '').includes('upload-artifact'))
      .map((step) => `${id}: ${step.name ?? step.uses ?? '?'}`);
  });
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
}

describe('e2e artifacts of a run against an Access-protected target (#142)', () => {
  it.each(workflowFiles())(
    '%s uploads no artifact from a job that holds the Access token or a BASE_URL',
    (file) => {
      const workflow = parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as Workflow;
      expect(uploadsFromTargetRuns(workflow)).toEqual([]);
    },
  );

  it('flags a stage e2e job that uploads the report', () => {
    const stageRun: Workflow = {
      jobs: {
        'e2e-stage': {
          steps: [
            {
              name: 'e2e',
              run: 'npx nx e2e console-e2e',
              env: { CF_ACCESS_CLIENT_SECRET: '${{ secrets.CF_ACCESS_CLIENT_SECRET }}' },
            },
            { name: 'Keep the report', uses: 'actions/upload-artifact@v7' },
          ],
        },
      },
    };
    expect(uploadsFromTargetRuns(stageRun)).toEqual(['e2e-stage: Keep the report']);
  });

  it('flags it when the token is set for the whole workflow', () => {
    const stageRun: Workflow = {
      env: { BASE_URL: 'https://team-console-stage.example.dev' },
      jobs: { e2e: { steps: [{ name: 'Upload', uses: 'actions/upload-artifact@v7' }] } },
    };
    expect(uploadsFromTargetRuns(stageRun)).toEqual(['e2e: Upload']);
  });

  it('leaves the local-stack e2e job and its failure artifact alone', () => {
    const localRun: Workflow = {
      jobs: { e2e: { steps: [{ name: 'Keep the report', uses: 'actions/upload-artifact@v7' }] } },
    };
    expect(uploadsFromTargetRuns(localRun)).toEqual([]);
  });
});
