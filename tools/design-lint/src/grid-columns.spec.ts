import { findGridsWithoutColumns, gridFilesOverBaseline } from './grid-columns';

const lines = (css: string) => findGridsWithoutColumns(css).map((found) => `${found.line}:${found.selector}`);

describe('findGridsWithoutColumns', () => {
  it('flags a grid rule with no column template', () => {
    expect(lines('.a {\n  display: grid;\n  gap: 1px;\n}\n.b { display: inline-grid }')).toEqual(['1:.a', '5:.b']);
  });

  it('passes grid-template-columns, grid-template and the grid shorthand', () => {
    const css = `.a { display: grid; grid-template-columns: minmax(0, 1fr); }
      .b { display: grid; grid-template: auto / minmax(0, 1fr); }
      .c { display: grid; grid: auto-flow / 1fr 1fr; }`;
    expect(lines(css)).toEqual([]);
  });

  it('judges each rule on its own, including inside @media', () => {
    const css =
      '@media (min-width: 40rem) {\n  .a { display: grid; }\n}\n.a { display: grid; grid-template-columns: 1fr; }';
    expect(lines(css)).toEqual(['2:.a']);
  });

  it('passes a rule that explains the implicit columns', () => {
    expect(lines('.a { display: grid; /* grid-columns-ok: one column of icons, sized by content */ }')).toEqual([]);
  });

  it('ignores a commented-out grid, other displays and grid-like names', () => {
    expect(lines('.a { /* display: grid; */ color: red; }\n.b { display: flex; }\n.grid { display: block; }')).toEqual(
      [],
    );
  });

  it('reads a style attribute without a rule around it', () => {
    expect(lines('display: grid; gap: 1px')).toEqual(['1:style']);
    expect(lines('display: grid; grid-template-columns: 1fr')).toEqual([]);
  });
});

describe('gridFilesOverBaseline', () => {
  it('flags a file with more findings than its baseline, or any finding in an unlisted file', () => {
    expect(gridFilesOverBaseline({ 'a.css': 2, 'b.css': 1, 'c.css': 1 }, { 'a.css': 2, 'b.css': 0 })).toEqual([
      'b.css',
      'c.css',
    ]);
  });

  it('lets a file with fewer findings than its baseline pass', () => {
    expect(gridFilesOverBaseline({ 'a.css': 1 }, { 'a.css': 3 })).toEqual([]);
  });
});
