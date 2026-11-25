import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const motionCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'motion.css'), 'utf8');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The declaration block of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const match = new RegExp(`(?:^|\\n)${escapeRegExp(selector)} \\{([^}]*)\\}`).exec(motionCss);
  if (!match?.[1]) {
    throw new Error(`no rule for ${selector} in motion.css`);
  }
  return match[1];
}

function keyframes(name: string): string {
  const match = new RegExp(`@keyframes ${escapeRegExp(name)} \\{([\\s\\S]*?)\\n\\}`).exec(motionCss);
  if (!match?.[1]) {
    throw new Error(`no @keyframes ${name} in motion.css`);
  }
  return match[1];
}

describe('motion classes (#506, #964)', () => {
  it.each([
    ['.m-enter', 'm-enter', '--dur-base', '--ease-enter'],
    ['.m-push', 'm-push', '--dur-base', '--ease-standard'],
    ['.m-fade', 'm-fade', '--dur-fast', '--ease-standard'],
    ['.m-stagger', 'm-enter', '--dur-base', '--ease-enter'],
    ['.m-route > :not(router-outlet, .m-route-skip)', 'm-enter', '--dur-base', '--ease-enter'],
  ])('%s plays %s on the duration and easing tokens', (selector, name, duration, easing) => {
    expect(rule(selector)).toMatch(
      new RegExp(`animation:\\s*${name} var\\(${duration}\\) var\\(${easing}\\) `),
    );
  });

  // A forwards-filling transform stays in effect after it ends and would keep the element a containing block for
  // its fixed and sticky descendants.
  it.each(['.m-enter', '.m-push', '.m-fade', '.m-stagger', '.m-route > :not(router-outlet, .m-route-skip)'])(
    '%s fills backwards only',
    (selector) => {
      expect(rule(selector)).toMatch(/\sbackwards;/);
    },
  );

  it('every enter starts transparent and ends on the element’s own style (no `to` frame)', () => {
    for (const name of ['m-enter', 'm-push', 'm-fade']) {
      expect(keyframes(name)).toMatch(/from \{[^}]*opacity: 0;/);
      expect(keyframes(name)).not.toMatch(/\bto \{/);
    }
  });

  it('.m-enter rises and .m-push slides by --motion-shift, the one switch reduced motion zeroes', () => {
    expect(keyframes('m-enter')).toContain('transform: translateY(var(--motion-shift));');
    expect(keyframes('m-push')).toContain('transform: translateX(calc(var(--motion-shift) * 3));');
  });

  it('.m-fade is opacity only', () => {
    expect(keyframes('m-fade')).not.toMatch(/transform/);
  });

  it('.m-leave fades out, holds its last frame and takes no pointer events', () => {
    expect(rule('.m-leave')).toMatch(/animation:\s*m-leave var\(--dur-fast\) var\(--ease-exit\) both;/);
    expect(rule('.m-leave')).toContain('pointer-events: none;');
    expect(keyframes('m-leave')).toMatch(/to \{[^}]*opacity: 0;/);
  });

  it('.m-stagger delays a row by its place, by the --stagger token', () => {
    expect(rule('.m-stagger')).toMatch(
      /animation-delay:\s*calc\(min\(var\(--i, 0\), \d+\) \* var\(--stagger\)\);/,
    );
  });

  it('only transform and opacity move (iPhone budget)', () => {
    for (const name of ['m-enter', 'm-push', 'm-fade', 'm-leave']) {
      const properties = [...keyframes(name).matchAll(/([a-z-]+):/g)].map((match) => match[1]);
      expect(properties.filter((property) => property !== 'opacity' && property !== 'transform')).toEqual([]);
    }
  });

  describe('under reduced motion', () => {
    // `.m-fade` is not in the list yet: its override is a product change that waits for the freeze to lift (#972).
    const enters = '.m-enter, .m-push, .m-stagger, .m-route > :not(router-outlet, .m-route-skip)';

    it('the media query swaps each rising or sliding enter for the --dur-fade fade', () => {
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

    it.todo('.m-fade takes the --dur-fade fade too (#972, after the freeze)');
  });
});
