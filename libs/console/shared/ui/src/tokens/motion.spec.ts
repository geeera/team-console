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
    throw new Error(`no rule for ${selector} in motion.css`);
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

describe('motion classes (#506, #964)', () => {
  it.each([
    ['.m-enter', 'm-enter'],
    ['.m-push', 'm-push'],
    ['.m-fade', 'm-fade'],
    ['.m-stagger', 'm-enter'],
  ])('%s plays its keyframes and fills backwards only', (selector, keyframes) => {
    const body = rule(motionCss, selector);
    expect(body).toMatch(new RegExp(`animation:\\s*${keyframes} `));
    expect(body).toMatch(/\sbackwards;/);
    expect(motionCss).toMatch(new RegExp(`@keyframes ${keyframes} \\{`));
  });

  it('.m-fade is opacity only', () => {
    const keyframes = /@keyframes m-fade \{([\s\S]*?)\n\}/.exec(motionCss)?.[1] ?? '';
    expect(keyframes).toMatch(/opacity: 0;/);
    expect(keyframes).not.toMatch(/transform/);
  });

  it('.m-leave fades out, fills forwards and takes no pointer events', () => {
    const body = rule(motionCss, '.m-leave');
    expect(body).toMatch(/animation:\s*m-leave .* both;/);
    expect(body).toContain('pointer-events: none;');
  });

  describe('under reduced motion', () => {
    const enters = '.m-enter, .m-push, .m-fade, .m-stagger, .m-route > :not(router-outlet, .m-route-skip)';

    it('the media query swaps every enter, .m-fade included, for the --dur-fade fade', () => {
      const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(motionCss)?.[1] ?? '';
      expect(media).toContain(`:root:not([data-motion='full']) :is(${enters})`);
      expect(media).toContain('animation-duration: var(--dur-fade);');
    });

    it("the data-motion='reduce' override does the same", () => {
      expect(motionCss).toMatch(
        new RegExp(
          `:root\\[data-motion='reduce'\\] :is\\(${escapeRegExp(enters)}\\) \\{\\s*animation-duration: var\\(--dur-fade\\);`,
        ),
      );
    });
  });
});
