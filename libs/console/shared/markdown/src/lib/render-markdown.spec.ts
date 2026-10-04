import { renderMarkdown as render } from './render-markdown';
import { MARKDOWN_MAX_LENGTH } from './rendered-markdown';

const renderMarkdown = (text: string) => render(text, { imageLabel: 'изображение' });

/**
 * XSS corpus (#20 acceptance criteria): classic DOMPurify/OWASP vectors plus GitHub-shaped cases. Every entry must
 * come out with no executable element, no event handler, no style hook and no link outside https/mailto/#.
 */
const CORPUS: readonly string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="https://evil.example/a.png" onload="alert(1)">',
  '<IMG SRC="javascript:alert(1);">',
  '<img src=`javascript:alert(1)`>',
  '<img """><script>alert(1)</script>">',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="https://evil.example/x.swf"></object>',
  '<embed src="https://evil.example/x.swf">',
  '<form action="https://evil.example"><input name=a><button>go</button></form>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href="  javascript:alert(1)">click</a>',
  '<a href="java&#x09;script:alert(1)">click</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
  '<a href="vbscript:msgbox(1)">click</a>',
  '<a href="http://insecure.example">plain http</a>',
  '[click](javascript:alert(1))',
  '[click](  javascript:alert(1)  )',
  '[click](data:text/html,<script>alert(1)</script>)',
  '![x](javascript:alert(1))',
  '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
  '<div style="position:fixed;inset:0;opacity:0">overlay</div>',
  '<p class="tc-sr-only" id="app">hidden</p>',
  '<a href="https://ok.example" onclick="alert(1)" style="display:none">ok</a>',
  '<details open ontoggle=alert(1)><summary>x</summary></details>',
  '<body onload=alert(1)>',
  '<style>body{display:none}</style>',
  '<link rel=stylesheet href=https://evil.example/x.css>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<template><script>alert(1)</script></template>',
  '<a href="https://ok.example"><img src=x onerror=alert(1)></a>',
  '<input autofocus onfocus=alert(1)>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)>',
  '<isindex action=javascript:alert(1) type=image>',
  '<x onmouseover=alert(1)>hover</x>',
  '`<script>alert(1)</script>`',
  '```html\n<script>alert(1)</script>\n```',
  '<!-- pt-architect-note --><script>alert(1)</script>',
  '**Architect note**\n\n<img src=x onerror=alert(1)>',
  '<a href="https://ok.example" target="_self" rel="opener">x</a>',
  '<a xlink:href="javascript:alert(1)">x</a>',
  '<table><tr><td background="javascript:alert(1)">x</td></tr></table>',
];

const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'style',
  'svg',
  'math',
  'link',
  'meta',
  'base',
  'img',
  'video',
  'audio',
  'source',
  'template',
  'noscript',
];

function parse(html: string): HTMLElement {
  const container = document.implementation.createHTMLDocument('').createElement('div');
  container.innerHTML = html;
  return container;
}

function expectInert(html: string): void {
  const root = parse(html);
  for (const tag of FORBIDDEN_TAGS) {
    expect(root.querySelector(tag), `<${tag}> survived in ${html}`).toBeNull();
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.startsWith('on'), `${attribute.name} survived in ${html}`).toBe(false);
      expect(['style', 'class', 'id', 'name', 'srcdoc', 'background']).not.toContain(attribute.name);
    }
    const href = element.getAttribute('href');
    if (href !== null) {
      expect(href, `unsafe href in ${html}`).toMatch(/^(?:https:|mailto:|#)/);
    }
    expect(element.getAttribute('src')).toBeNull();
  }
}

describe('renderMarkdown', () => {
  it.each(CORPUS)('leaves nothing executable: %s', (input) => {
    expectInert(renderMarkdown(input).html);
  });

  it('renders ordinary markdown as prose', () => {
    const { html } = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    const root = parse(html);
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('code')?.textContent).toBe('code');
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelector('td')?.textContent).toBe('1');
  });

  it('opens every external link in a new tab without opener or referrer', () => {
    const { html, links } = renderMarkdown(
      '[spec](https://example.pages.dev/?path=/story/x) and <a href="https://ok.example" target="_self" rel="opener">raw</a>',
    );
    const anchors = Array.from(parse(html).querySelectorAll('a'));
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(links).toEqual(['https://example.pages.dev/?path=/story/x', 'https://ok.example/']);
  });

  it('keeps the text of a dangerous link but drops its href', () => {
    const anchor = parse(renderMarkdown('[click](javascript:alert(1))').html).querySelector('a');
    expect(anchor?.hasAttribute('href') ?? false).toBe(false);
    expect(parse(renderMarkdown('[click](javascript:alert(1))').html).textContent).toContain('click');
  });

  it('lists only https links, once each, in document order', () => {
    const { links } = renderMarkdown(
      '[a](https://b.example) [m](mailto:x@example.com) [h](#top) [a2](https://b.example) <http://plain.example> [c](https://c.example)',
    );
    expect(links).toEqual(['https://b.example/', 'https://c.example/']);
  });

  it('turns an image into a link named by its alt text', () => {
    const { html, links } = renderMarkdown('![Editor states](https://example.com/shots/editor.png)');
    const anchor = parse(html).querySelector('a');
    expect(anchor?.textContent).toBe('Editor states');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/shots/editor.png');
    expect(links).toEqual(['https://example.com/shots/editor.png']);
  });

  it('names an image without alt text by its file name', () => {
    const anchor = parse(renderMarkdown('<img src="https://example.com/a/b%20c.png">').html).querySelector('a');
    expect(anchor?.textContent).toBe('b c.png');
  });

  it('keeps only the label of an image whose source is not https', () => {
    const { html, links } = renderMarkdown('![shot](data:image/png;base64,AAAA)');
    expect(parse(html).querySelector('a')).toBeNull();
    expect(parse(html).textContent).toContain('shot');
    expect(links).toEqual([]);
  });

  it('drops the team markers and leaves a fake note header as plain text', () => {
    const { html } = renderMarkdown('<!-- pt-architect-note -->\n**Architect note**\n\nhello');
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('pt-architect-note');
    expect(parse(html).querySelector('strong')?.textContent).toBe('Architect note');
  });

  it('removes every iframe, whatever its origin', () => {
    const { html } = renderMarkdown('<iframe src="https://team-console-storybook.pages.dev"></iframe>');
    expect(parse(html).querySelector('iframe')).toBeNull();
  });

  it('cuts a body longer than GitHub allows instead of parsing all of it', () => {
    const { html } = renderMarkdown('a'.repeat(MARKDOWN_MAX_LENGTH + 500));
    expect(parse(html).textContent?.trim().length).toBe(MARKDOWN_MAX_LENGTH);
  });

  it('names an image with neither alt text nor a usable source by the translated label (#189)', () => {
    expect(parse(render('<img src=x>', { imageLabel: 'изображение' }).html).textContent).toBe('изображение');
    expect(parse(render('<img src=x>', { imageLabel: 'image' }).html).textContent).toBe('image');
  });
});
