import { findRawValues } from './raw-values';

const kinds = (css: string) => findRawValues(css).map((v) => `${v.kind}:${v.value}`);

describe('findRawValues', () => {
  it('passes a stylesheet that reads tokens only', () => {
    const css = `
      :host {
        padding: 0 var(--space-4);
        border: 1px solid var(--border);
        color: var(--text);
        transition: color var(--dur-fast) var(--ease-standard);
        z-index: var(--z-chrome);
        line-height: 1.25;
        stroke-width: 1.8;
        opacity: 0.55;
      }
    `;
    expect(findRawValues(css)).toEqual([]);
  });

  it('flags hex, functional and named colours', () => {
    expect(kinds('a { color: #29251F; background: rgba(0,0,0,.3); border-color: red; }')).toEqual([
      'colour:#29251F',
      'colour:rgba(',
      'colour:red',
    ]);
  });

  it('flags lengths other than 0 and the 1px hairline', () => {
    expect(kinds('a { margin: 0 8px; padding: 1.5rem; width: 1px; height: 0; gap: .5em; }')).toEqual([
      'length:8px',
      'length:1.5rem',
      'length:.5em',
    ]);
  });

  it('flags durations', () => {
    expect(kinds('a { transition: opacity 240ms ease; animation: spin 1.2s linear; }')).toEqual([
      'duration:240ms',
      'duration:1.2s',
    ]);
  });

  it('flags numeric z-index', () => {
    expect(kinds('a { z-index: 40; }')).toEqual(['z-index:40']);
  });

  it('ignores @media preludes and comments', () => {
    const css = `
      /* 0 8px #fff 120ms would all be raw */
      @media (max-width: 519.98px) {
        a { padding: var(--space-2); }
      }
    `;
    expect(findRawValues(css)).toEqual([]);
  });

  it('does not read property names as values', () => {
    expect(
      findRawValues('a { white-space: nowrap; line-height: 1.5; min-height: 100dvh; width: 100vw; }'),
    ).toEqual([]);
  });

  it('ignores the numbers in SVG stroke geometry and ratios', () => {
    expect(
      findRawValues('a { stroke-dasharray: 200; stroke-dashoffset: 200; aspect-ratio: 9/15; flex: 1 1 0; }'),
    ).toEqual([]);
  });

  it('reports the line of each finding', () => {
    const css = ['a {', '  color: var(--text);', '  padding: 4px;', '}'].join('\n');
    expect(findRawValues(css)).toEqual([
      { line: 3, kind: 'length', value: '4px', declaration: 'padding: 4px' },
    ]);
  });

  it('can allow token definitions, for the tokens file itself', () => {
    const css = ':root { --bg: #f7f3ec; --space-1: 4px; }';
    expect(findRawValues(css, { allowTokenDefinitions: true })).toEqual([]);
    expect(findRawValues(css)).toHaveLength(2);
  });
});
