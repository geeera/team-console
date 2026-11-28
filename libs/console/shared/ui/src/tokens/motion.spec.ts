import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGGER_MAX_INDEX, staggerIndex } from './motion';

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, 'tokens.css'), 'utf8');
const motionCss = readFileSync(join(here, '../styles/motion.css'), 'utf8');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The declaration block of the rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`(?:^|\\n)${escapeRegExp(selector)} \\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) {
    throw new Error(`no rule for ${selector} in the stylesheet`);
  }
  return match[1];
}

describe('stagger cap (#968)', () => {
  it('is the one --stagger-max token, equal to the TS constant', () => {
    expect(/--stagger-max:\s*(\d+);/.exec(tokensCss)?.[1]).toBe(String(STAGGER_MAX_INDEX));
  });

  it('is read by .m-stagger from the token, not repeated as a number', () => {
    expect(rule(motionCss, '.m-stagger')).toMatch(/min\(var\(--i, 0\), var\(--stagger-max\)\)/);
  });

  it('holds an index at the cap and leaves the ones below it', () => {
    expect(staggerIndex(0)).toBe(0);
    expect(staggerIndex(STAGGER_MAX_INDEX)).toBe(STAGGER_MAX_INDEX);
    expect(staggerIndex(STAGGER_MAX_INDEX + 20)).toBe(STAGGER_MAX_INDEX);
  });
});
