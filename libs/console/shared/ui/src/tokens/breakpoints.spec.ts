import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREAKPOINTS } from './breakpoints';

// The Analog plugin turns a `?raw` css import into an empty string, so the file is read directly.
function tokenValue(name: string): string {
  const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss);
  if (!match?.[1]) {
    throw new Error(`token --${name} is missing from tokens.css`);
  }
  return match[1].trim();
}

describe('breakpoints', () => {
  it('matches the phone breakpoint token in tokens.css', () => {
    expect(BREAKPOINTS.phone).toBe(`(max-width: ${tokenValue('bp-phone-max')})`);
  });

  it('matches the tablet breakpoint token in tokens.css', () => {
    expect(BREAKPOINTS.tablet).toBe(`(max-width: ${tokenValue('bp-tablet-max')})`);
  });
});
