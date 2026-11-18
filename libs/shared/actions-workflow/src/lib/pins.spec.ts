import { compareVersions, loweredPinsOf, readRunnerWorkflowPins } from './pins';
import { renderRunnerWorkflow } from './render';

// #759 PR 4: the pins of the file on a default branch, read without parsing the customer's YAML.

async function rendering() {
  const rendered = await renderRunnerWorkflow({ consoleOrigin: 'https://console.example.com', environment: 'dev' });
  if (!rendered.ok) {
    throw new Error(rendered.failure);
  }
  return rendered.rendering;
}

describe('readRunnerWorkflowPins', () => {
  it('reads the three pins of the console’s own rendering', async () => {
    const { text, pins } = await rendering();
    expect(readRunnerWorkflowPins(text)).toEqual(pins);
  });

  it('reads a quoted pin, and nothing from a text without one', () => {
    expect(readRunnerWorkflowPins("  env:\n    RUNNER_VERSION: '1.2.3'\n").runner).toBe('1.2.3');
    expect(readRunnerWorkflowPins('name: other\n')).toEqual({ runner: null, node: null, claudeCode: null });
  });

  it.each([
    ['named twice', '  RUNNER_VERSION: 1.2.3\n  RUNNER_VERSION: 9.9.9\n'],
    ['not a plain version', '  RUNNER_VERSION: 1.2.3-rc.1\n'],
    ['an expression', '  RUNNER_VERSION: ${{ vars.RUNNER }}\n'],
    ['with text after it', '  RUNNER_VERSION: 1.2.3 @someone\n'],
    ['with mismatched quotes', '  RUNNER_VERSION: \'1.2.3"\n'],
    ['too many digits', '  RUNNER_VERSION: 123456.0.0\n'],
  ])('reads no pin when it is %s', (_case, text) => {
    expect(readRunnerWorkflowPins(text).runner).toBeNull();
  });

  it('reads nothing from a text far larger than a workflow', () => {
    expect(readRunnerWorkflowPins(`  RUNNER_VERSION: 1.2.3\n${'#'.repeat(70 * 1024)}`).runner).toBeNull();
  });
});

describe('compareVersions and loweredPinsOf', () => {
  it('compares part by part as numbers', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('22.3.0', '22.23.5')).toBe(-1);
  });

  it('lists only the pins the rendering would lower', () => {
    const next = { runner: '0.2.0', node: '22.23.5', claudeCode: '2.1.325' };
    expect(loweredPinsOf({ runner: '0.1.0', node: '22.23.5', claudeCode: '2.1.325' }, next)).toEqual([]);
    expect(loweredPinsOf({ runner: '0.3.0', node: '22.23.5', claudeCode: '2.2.0' }, next)).toEqual(['runner', 'claudeCode']);
    expect(loweredPinsOf({ runner: null, node: null, claudeCode: null }, next)).toEqual([]);
  });
});
