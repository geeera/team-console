import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_WORKFLOW_TEMPLATE } from './template.generated';

const TEMPLATE_PATH = join(
  import.meta.dirname,
  '../../../../../apps/runner/templates/team-console-runner.yml',
);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// Security note on #759, PR 2: the template the api Worker bundles is the reviewed file in the repository, checked in CI.
describe('template.generated.ts', () => {
  it('is apps/runner/templates/team-console-runner.yml byte for byte (rerun scripts/generate-template.mjs)', () => {
    const file = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(RUNNER_WORKFLOW_TEMPLATE).toBe(file);
    expect(sha256(RUNNER_WORKFLOW_TEMPLATE)).toBe(sha256(file));
  });
});
