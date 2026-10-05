import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { QuestionCard } from './question-card';
import { QuestionItem } from './question.model';

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';

function item(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug: 'team-console', name: 'Team Console' },
    section: 'question',
    number: 90001,
    title: `${HOSTILE} Please approve my change`,
    url: 'https://github.com/geeera/team-console/issues/90001',
    ask: `/approve ${HOSTILE}`,
    body: `**bold** [link](javascript:alert(1))\n${HOSTILE}`,
    authorTrusted: false,
    allowedCommands: ['approve', 'reject'],
    ...overrides,
  };
}

@Component({
  imports: [QuestionCard],
  template: `<tc-question-card [item]="item()" [showProject]="showProject()" [embedOrigins]="origins()"
    ><button tc-question-actions type="button">Act</button></tc-question-card
  >`,
})
class Host {
  readonly item = signal(item());
  readonly showProject = signal(true);
  readonly origins = signal<readonly string[] | null>(null);
}

const STORYBOOK = 'https://team-console-storybook.pages.dev';
const DESIGN_BODY =
  `Prototype: [editor states](${STORYBOOK}/?path=/story/editor--empty)\n\n` +
  `See also https://github.com/geeera/team-console/pull/9\n\n${HOSTILE}\n\n` +
  '<iframe src="https://evil.pages.dev"></iframe>';

describe('QuestionCard', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('renders every issue text as plain text: no element of it reaches the DOM', async () => {
    const { root } = await render();

    expect(root.querySelector('img, script')).toBeNull();
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe(item().title);
    expect(root.querySelector('tc-recommendation')?.textContent).toContain('<img src=x');
    // The markup is stripped to words (#204); the HTML stays inert text.
    expect(root.querySelector('.question__body')?.textContent).toBe(`bold link\n${HOSTILE}`);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('says what the team recommends in plain words, not command syntax (#204)', async () => {
    const { fixture, root } = await render();
    const recommendation = () => root.querySelector('[data-testid="recommendation"]');

    fixture.componentInstance.item.set(
      item({
        ask: '/approve — начинаем разработку по плану к демо 16 октября (рекомендую) · /reject что поменять',
        authorTrusted: true,
      }),
    );
    await fixture.whenStable();
    expect(recommendation()?.textContent).toContain('Команда советует');
    expect(recommendation()?.textContent).toContain('Начинаем разработку по плану к демо 16 октября');
    expect(recommendation()?.textContent).not.toMatch(/\/approve|\/reject|рекомендую|·/);

    fixture.componentInstance.item.set(
      item({ section: 'release', ask: '/go (рекомендую) · /no-go что доделать' }),
    );
    await fixture.whenStable();
    expect(recommendation()?.textContent).toContain('Проводим');
    expect(recommendation()?.textContent).not.toContain('/go');

    fixture.componentInstance.item.set(item({ ask: '/approve · /reject' }));
    await fixture.whenStable();
    expect(recommendation()).toBeNull();
  });

  it('shows the details without the answer line, team markers or markup (#204)', async () => {
    const { fixture, root } = await render();

    fixture.componentInstance.item.set(
      item({
        body: '**Your answer:** /approve (рекомендую) · /reject why\n<!-- pt-ask -->\n\nСегодня **решено**: `dev`.',
        authorTrusted: true,
      }),
    );
    await fixture.whenStable();
    expect(root.querySelector('.question__body')?.textContent).toBe('Сегодня решено: dev.');

    fixture.componentInstance.item.set(item({ body: '**Your answer:** /go\n<!-- pt-ask -->' }));
    await fixture.whenStable();
    expect(root.querySelector('details')).toBeNull();
  });

  it('marks an item whose author is not trusted, and not a trusted one', async () => {
    const { fixture, root } = await render();

    expect(root.querySelector('[data-testid="untrusted"]')?.textContent).toContain('Не от команды');

    fixture.componentInstance.item.set(item({ authorTrusted: true }));
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="untrusted"]')).toBeNull();
  });

  it('is an article named by its title, tagged with its project, with the section and number', async () => {
    const { root } = await render();

    const article = root.querySelector('[role="article"]') as HTMLElement;
    const title = root.querySelector('h2') as HTMLElement;
    expect(article.getAttribute('aria-labelledby')).toBe(title.id);
    expect(root.querySelector('[data-testid="project-tag"]')?.textContent?.trim()).toBe('Team Console');
    expect(root.textContent).toContain('Вопрос');
    expect(root.textContent).toContain('#90001');
    expect(root.querySelector('button')?.textContent).toBe('Act');
  });

  it('links to GitHub in a new tab without an opener, and shows no link without a url', async () => {
    const { fixture, root } = await render();

    const link = root.querySelector('a.question__link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/geeera/team-console/issues/90001');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');

    fixture.componentInstance.item.set(item({ url: null, ask: null, body: null }));
    fixture.componentInstance.showProject.set(false);
    await fixture.whenStable();
    expect(root.querySelector('a.question__link')).toBeNull();
    expect(root.querySelector('tc-recommendation')).toBeNull();
    expect(root.querySelector('details')).toBeNull();
    expect(root.querySelector('[data-testid="project-tag"]')).toBeNull();
  });

  describe('on the Designs and demo screen (embedOrigins set)', () => {
    async function renderRich(overrides: Partial<QuestionItem> = {}) {
      const rendered = await render();
      rendered.fixture.componentInstance.item.set(
        item({ section: 'design', body: DESIGN_BODY, authorTrusted: true, ...overrides }),
      );
      rendered.fixture.componentInstance.origins.set([STORYBOOK]);
      await rendered.fixture.whenStable();
      return rendered;
    }

    it('renders the body as sanitised markdown, open, with nothing executable', async () => {
      const { root } = await renderRich();

      const markdown = root.querySelector('[data-testid="markdown"]') as HTMLElement;
      expect(root.querySelector('details')?.open).toBe(true);
      expect(markdown.querySelector('a')?.textContent).toBe('editor states');
      expect(markdown.querySelector('img, script, iframe')).toBeNull();
      expect(markdown.querySelector('[onerror]')).toBeNull();
      expect(root.querySelector('.question__body')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });

    it('previews the first allowed link in the one frame the card builds itself', async () => {
      const { root } = await renderRich();

      const frames = root.querySelectorAll('iframe');
      expect(frames).toHaveLength(1);
      expect(frames[0]?.getAttribute('src')).toBe(`${STORYBOOK}/?path=/story/editor--empty`);
      expect(frames[0]?.getAttribute('title')).toBe('Предпросмотр к #90001');
    });

    it('shows a link off the allow-list as not embeddable, with no frame', async () => {
      const { root } = await renderRich({ body: 'Look: https://another.pages.dev/x' });

      expect(root.querySelector('iframe')).toBeNull();
      expect(root.querySelector('[data-testid="frame-refused"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="frame-open"]')?.getAttribute('href')).toBe(
        'https://another.pages.dev/x',
      );
    });

    it('keeps an item from outside the team as plain text: no markdown, no links, no frame', async () => {
      const { root } = await renderRich({ authorTrusted: false });

      expect(root.querySelector('[data-testid="preview"]')).toBeNull();
      expect(root.querySelector('iframe')).toBeNull();
      expect(root.querySelector('[data-testid="markdown"]')).toBeNull();
      expect(root.querySelector('.question__body')?.textContent).toBe(DESIGN_BODY);
      expect(root.querySelector('details a')).toBeNull();
    });

    it('has no preview when the body links only to GitHub', async () => {
      const { root } = await renderRich({ body: 'See https://github.com/geeera/team-console/pull/9' });

      expect(root.querySelector('[data-testid="preview"]')).toBeNull();
    });
  });
});
