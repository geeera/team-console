import { compareVersions, differsOnlyInReleaseValues, loweredPinsOf, readRunnerWorkflowPins } from './pins';
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

describe('differsOnlyInReleaseValues (#870)', () => {
  /** The rendering at another release: every pin and checksum line given a different value, layout kept. */
  const olderRelease = (text: string): string =>
    text
      .replace(/^(\s+RUNNER_VERSION: ).*$/m, '$10.0.9')
      .replace(/^(\s+NODE_VERSION: ).*$/m, '$122.1.0')
      .replace(/^(\s+NODE_SHA256: ).*$/m, `$1${'0'.repeat(64)}`)
      .replace(/^(\s+CLAUDE_CODE_VERSION: ).*$/m, '$12.0.0')
      .replace(/^(\s+CLAUDE_CODE_SHA512: ).*$/m, `$1${'1'.repeat(128)}`);

  it('is true for the rendering itself and for the rendering at another release', async () => {
    const { text } = await rendering();
    expect(differsOnlyInReleaseValues(text, text)).toBe(true);
    const older = olderRelease(text);
    expect(older).not.toBe(text);
    expect(differsOnlyInReleaseValues(older, text)).toBe(true);
  });

  it.each<[string, (text: string) => string]>([
    ['one more line', (text) => `${text}# appended\n`],
    ['another step command', (text) => text.replace('--deny-self-hosted-runners', '')],
    ['a pin line repeated', (text) => text.replace(/^(\s+RUNNER_VERSION: .*)$/m, '$1\n$1')],
    ['a pin line missing', (text) => text.replace(/^\s+NODE_SHA256: .*\n/m, '')],
    ['a checksum of the wrong length', (text) => text.replace(/^(\s+NODE_SHA256: ).*$/m, `$1${'0'.repeat(63)}`)],
    ['a pin that is an expression', (text) => text.replace(/^(\s+RUNNER_VERSION: ).*$/m, '$1${{ vars.V }}')],
  ])('is false with %s', async (_case, change) => {
    const { text } = await rendering();
    expect(differsOnlyInReleaseValues(change(olderRelease(text)), text)).toBe(false);
  });

  it('is false for a text far larger than a workflow', async () => {
    const { text } = await rendering();
    expect(differsOnlyInReleaseValues(`${text}${'#'.repeat(70 * 1024)}`, text)).toBe(false);
  });
});
