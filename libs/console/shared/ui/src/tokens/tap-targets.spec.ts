import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREAKPOINTS } from './breakpoints';

const HERE = dirname(fileURLToPath(import.meta.url));

// The Analog plugin turns a `?raw` css import into an empty string, so the files are read directly
// (same approach as breakpoints.spec.ts).
function read(...segments: string[]): string {
  return readFileSync(join(HERE, ...segments), 'utf8');
}

function tokenValue(css: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!match?.[1]) {
    throw new Error(`token --${name} is missing`);
  }
  return match[1].trim();
}

describe('tap targets — UX spec §5, 44px on the phone (#124 item 4)', () => {
  const tokensCss = read('tokens.css');

  it('390px (iPhone) falls inside the phone breakpoint the tap-target rules key off', () => {
    const phoneMax = Number.parseFloat(tokenValue(tokensCss, 'bp-phone-max'));
    expect(390).toBeLessThan(phoneMax);
    expect(BREAKPOINTS.phone).toBe(`(max-width: ${tokenValue(tokensCss, 'bp-phone-max')})`);
  });

  it('the small touch control height token is a real 44px target, not a narrower one', () => {
    expect(tokenValue(tokensCss, 'control-h-touch-sm')).toBe('44px');
    expect(tokenValue(tokensCss, 'control-h-touch')).toBe('44px');
  });

  it('tc-icon-button grows to the 44px touch size on the phone, so the switcher’s pin qualifies', () => {
    const css = read('..', 'lib', 'button', 'icon-button.css');
    expect(css).toMatch(
      /@media \(max-width: 519\.98px\) \{\s*:host \{\s*width: var\(--control-h-touch\);\s*height: var\(--control-h-touch\);/,
    );
  });

  it('the shared .tc-tap-target utility holds a plain link or button to 44px on the phone', () => {
    const css = read('..', 'styles', 'base.css');
    // `!important`: it must win over a page's own component-scoped rule regardless of specificity.
    expect(css).toMatch(
      /@media \(max-width: 519\.98px\) \{[\s\S]*?\.tc-tap-target \{\s*min-height: var\(--control-h-touch\) !important;/,
    );
  });
});
