import { markdownToPlainText } from './plain-text';
import { MARKDOWN_MAX_LENGTH } from './rendered-markdown';

describe('markdownToPlainText', () => {
  it('drops HTML comments, including the team markers and one left open', () => {
    expect(markdownToPlainText('Ask\n<!-- pt-ask -->\n\nBody <!-- note\nover lines --> end')).toBe(
      'Ask\n\nBody  end',
    );
    expect(markdownToPlainText('Visible <!-- never closed\nhidden')).toBe('Visible');
  });

  it('drops emphasis, strike-through and code marks but keeps their words', () => {
    expect(markdownToPlainText('**bold** __strong__ *it* _em_ ~~old~~ `code` ``double``')).toBe(
      'bold strong it em old code double',
    );
  });

  it('keeps snake_case, file names and lone markers as they are', () => {
    expect(
      markdownToPlainText('run_log_issue and owner_grammar.ts, window.__x=1; y.__z, 2 * 3 * 4, a ** b'),
    ).toBe('run_log_issue and owner_grammar.ts, window.__x=1; y.__z, 2 * 3 * 4, a ** b');
  });

  it('keeps the words of a link and the alt text of an image, never the address', () => {
    expect(
      markdownToPlainText('See [the mockup](https://example.org/a) and ![screen](https://x.test/s.png)'),
    ).toBe('See the mockup and screen');
    expect(markdownToPlainText('[click](javascript:alert(1))')).toBe('click');
    expect(markdownToPlainText('Open <https://example.org/x>')).toBe('Open https://example.org/x');
  });

  it('turns headings, quotes, rules, fences and lists into plain lines', () => {
    const source = [
      '## What is in ##',
      '',
      '> quoted',
      '',
      '---',
      '- one',
      '  * two',
      '```ts',
      'const a = 1;',
      '```',
    ];
    expect(markdownToPlainText(source.join('\n'))).toBe(
      'What is in\n\nquoted\n\n• one\n  • two\nconst a = 1;',
    );
  });

  it('keeps a heading that only ends in a hash', () => {
    expect(markdownToPlainText('# Support C#')).toBe('Support C#');
  });

  it('reads a table row by row', () => {
    expect(markdownToPlainText('| Check | Result |\n|---|:---:|\n| e2e | green |')).toBe(
      'Check · Result\ne2e · green',
    );
  });

  it('unescapes markdown escapes and collapses runs of blank lines', () => {
    expect(markdownToPlainText('\\*not italic\\*\n\n\n\nnext')).toBe('*not italic*\n\nnext');
  });

  it('leaves HTML as inert text: the result is for interpolation only', () => {
    const hostile = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
    expect(markdownToPlainText(hostile)).toBe(hostile);
  });

  it('cuts text longer than GitHub allows', () => {
    expect(markdownToPlainText('a'.repeat(MARKDOWN_MAX_LENGTH + 10))).toHaveLength(MARKDOWN_MAX_LENGTH);
  });

  it('stays fast on input built to make patterns backtrack', () => {
    const hostile = ['[', '![', '**', '__', '~~', '`', ' ', '#', '| ', '<!--'].map((unit) =>
      unit.repeat(Math.floor(MARKDOWN_MAX_LENGTH / unit.length)),
    );
    const started = performance.now();
    for (const text of hostile) {
      markdownToPlainText(`${text}x`);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
