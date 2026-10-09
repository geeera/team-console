import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { QuestionCard } from './question-card';
import type { QuestionContextDto } from '@shared/contracts';
import { QuestionItem } from './question.model';

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';

function item(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug: 'team-console', name: 'Team Console' },
    section: 'question',
    number: 90001,
    title: `${HOSTILE} Please approve my change`,
    url: 'https://github.com/geeera/team-console/issues/90001',
    ask: `/approve ${HOSTILE} (recommended)`,
    body: `**bold** [link](javascript:alert(1))\n${HOSTILE}`,
    authorTrusted: false,
    allowedCommands: ['approve', 'reject'],
    category: null,
    recommendation: null,
    context: null,
    ...overrides,
  };
}

@Component({
  imports: [QuestionCard],
  template: `<tc-question-card [item]="item()" [showProject]="showProject()" [embedOrigins]="origins()"
    ><div tc-question-previews data-testid="slot-previews">Screens</div
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

    // An outsider's item keeps the answer line in plain words (#204): the server's verdict is not the team's.
    fixture.componentInstance.item.set(
      item({
        ask: '/approve — начинаем разработку по плану к демо 16 октября (рекомендую) · /reject что поменять',
        recommendation: 'approve',
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

    // A team item says the recommended answer as a verb (#276).
    fixture.componentInstance.item.set(
      item({ section: 'release', ask: '/go (рекомендую) · /no-go', recommendation: 'go', authorTrusted: true }),
    );
    await fixture.whenStable();
    expect(recommendation()?.textContent).toContain('Проводить демо.');
    expect(recommendation()?.textContent).not.toMatch(/\/go|рекомендую/);

  });

  it('shows an action item’s instruction in its own voice, never under "Команда советует" (#291)', async () => {
    const { fixture, root } = await render();

    fixture.componentInstance.item.set(
      item({
        section: 'owner',
        ask: 'Напиши «сделал», когда заведёшь аккаунты по чеклисту из #7 · /reject причина, если что-то не подходит',
        authorTrusted: true,
        allowedCommands: ['done'],
      }),
    );
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="recommendation"]')).toBeNull();
    const action = root.querySelector('[data-testid="action-text"]');
    expect(action?.textContent).toBe('Напиши «сделал», когда заведёшь аккаунты по чеклисту из #7');
    expect(root.textContent).not.toContain('·');
    expect(root.textContent).not.toContain('причина, если что-то не подходит');

    // A local section item behaves the same way, and a design item without a recommendation shows no block (#210).
    fixture.componentInstance.item.set(
      item({ section: 'local', ask: 'Переключи источник GitHub Pages', authorTrusted: true, allowedCommands: ['done'] }),
    );
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="recommendation"]')).toBeNull();
    expect(root.querySelector('[data-testid="action-text"]')?.textContent).toBe('Переключи источник GitHub Pages');

    fixture.componentInstance.item.set(
      item({ section: 'design', ask: '/approve онбординг · /reject что поменять', authorTrusted: false }),
    );
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="recommendation"]')).toBeNull();
    expect(root.querySelector('[data-testid="action-text"]')).toBeNull();
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
    // The external-link pattern: a decorative icon, and the new tab said in words for a screen reader.
    expect(link.querySelector('tc-icon[data-testid="external-icon"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(link.querySelector('.tc-sr-only')?.textContent?.trim()).toBe('(откроется в новой вкладке)');
    expect(link.textContent?.replace(/\s+/g, ' ').trim()).toBe('Открыть #90001 на GitHub (откроется в новой вкладке)');

    fixture.componentInstance.item.set(item({ url: null, ask: null, body: null }));
    fixture.componentInstance.showProject.set(false);
    await fixture.whenStable();
    expect(root.querySelector('a.question__link')).toBeNull();
    expect(root.querySelector('tc-recommendation')).toBeNull();
    expect(root.querySelector('details')).toBeNull();
    expect(root.querySelector('[data-testid="project-tag"]')).toBeNull();
  });

  describe('context to decide in the console (#276)', () => {
    const CONTEXT: QuestionContextDto = {
      summary: 'Экран дизайна и демо',
      question: 'Утвердить дизайн экрана «Дизайн и демо»?',
      why: 'Повторяет уже утверждённые карточки.',
      ifApproved: 'Разработчик начнёт #20.',
      ifRejected: 'Дизайнер переделает экран.',
      costAndRisk: 'Бесплатно. Риск низкий.',
      structured: true,
    };
    const TEAM_DESIGN: Partial<QuestionItem> = {
      section: 'design',
      title: 'Дизайн #20: экран дизайна и демо',
      ask: '/approve экран (рекомендую) · /reject что поменять',
      body: '**Your answer:** /approve экран (рекомендую) · /reject что поменять\n<!-- pt-ask -->\n\nТекст.',
      authorTrusted: true,
      recommendation: 'approve',
      context: CONTEXT,
    };
    const text = (root: HTMLElement, testId: string) =>
      root.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, ' ').trim();

    it('shows every section in its slot, in the order of the spec', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(item(TEAM_DESIGN));
      await fixture.whenStable();

      expect(root.querySelector('h2')?.textContent).toBe('Экран дизайна и демо');
      expect(text(root, 'github-title')).toBe('На GitHub: Дизайн #20: экран дизайна и демо');
      expect(text(root, 'question-text')).toBe(CONTEXT.question);
      expect(text(root, 'recommendation')).toContain('Утвердить. Повторяет уже утверждённые карточки.');
      const outcomes = Array.from(root.querySelectorAll('[data-testid="outcomes"] > div'), (row) => [
        row.querySelector('dt')?.textContent?.trim(),
        row.querySelector('dd')?.textContent?.trim(),
      ]);
      expect(outcomes).toEqual([
        ['Если утвердите', 'Разработчик начнёт #20.'],
        ['Если отклоните', 'Дизайнер переделает экран.'],
      ]);
      expect(text(root, 'cost')).toBe('Цена и риск: Бесплатно. Риск низкий.');

      const order = [
        'h2',
        '[data-testid="github-title"]',
        '[data-testid="question-text"]',
        '[data-testid="recommendation"]',
        '[data-testid="slot-previews"]',
        '[data-testid="outcomes"]',
        '[data-testid="cost"]',
        'button',
        'details',
        'a.question__link',
      ].map((selector) => root.querySelector(selector));
      expect(order.every((node) => node !== null)).toBe(true);
      for (let i = 1; i < order.length; i += 1) {
        const [before, after] = [order[i - 1] as Node, order[i] as Node];
        expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it('never shows the answer line, also not in the details', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(item(TEAM_DESIGN));
      await fixture.whenStable();
      expect(root.textContent).not.toMatch(/Your answer|Твой ответ|\/approve|\/reject/);

      fixture.componentInstance.origins.set([STORYBOOK]);
      await fixture.whenStable();
      expect(root.querySelector('[data-testid="markdown"]')?.textContent).not.toMatch(/Your answer|\/approve/);
    });

    it('falls back for a body without the sections: the answer line’s options become outcomes', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(
        item({
          ...TEAM_DESIGN,
          section: 'question',
          ask: '/approve добавить экспорт в CSV (рекомендую) · /reject почему',
          context: { ...CONTEXT, summary: null, why: null, ifApproved: null, ifRejected: null, costAndRisk: null, structured: false, question: 'Команда предлагает экспорт.' },
        }),
      );
      await fixture.whenStable();

      expect(root.querySelector('h2')?.textContent).toBe('Дизайн #20: экран дизайна и демо');
      expect(root.querySelector('[data-testid="github-title"]')).toBeNull();
      expect(text(root, 'question-text')).toBe('Команда предлагает экспорт.');
      expect(text(root, 'recommendation')).toContain('Одобрить.');
      // The reject side is only the plugin's placeholder prompt ("почему"): dropped, not shown as a bare prompt (#291).
      expect(Array.from(root.querySelectorAll('[data-testid="outcomes"] dd'), (dd) => dd.textContent)).toEqual([
        'Добавить экспорт в CSV',
      ]);
      expect(root.querySelector('[data-testid="outcomes"] dt')?.textContent).toBe('Если одобрите');
      expect(root.querySelector('[data-testid="cost"]')).toBeNull();
      expect(root.textContent).not.toMatch(/\/approve|\/reject|рекомендую/);
    });

    it('hides a slot whose section is missing, and asks for the price of a money decision', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(
        item({
          ...TEAM_DESIGN,
          section: 'question',
          category: 'money',
          context: { ...CONTEXT, question: null, ifRejected: null, costAndRisk: null },
        }),
      );
      await fixture.whenStable();

      expect(root.querySelector('[data-testid="question-text"]')).toBeNull();
      expect(root.querySelectorAll('[data-testid="outcomes"] > div')).toHaveLength(1);
      expect(text(root, 'cost')).toBe('Цена не указана — спросите PM');
    });

    it('shows the design previews only for the team’s own design question', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(item(TEAM_DESIGN));
      await fixture.whenStable();
      expect(root.querySelector('[data-testid="slot-previews"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="previews-untrusted"]')).toBeNull();

      fixture.componentInstance.item.set(item({ ...TEAM_DESIGN, section: 'question' }));
      await fixture.whenStable();
      expect(root.querySelector('[data-testid="slot-previews"]')).toBeNull();

      fixture.componentInstance.item.set(item({ ...TEAM_DESIGN, authorTrusted: false }));
      await fixture.whenStable();
      expect(root.querySelector('[data-testid="slot-previews"]')).toBeNull();
      expect(text(root, 'previews-untrusted')).toBe(
        'Превью скрыто: этот вопрос создала не команда. Откройте его на GitHub, если доверяете автору.',
      );
    });

    it('ignores context on an outsider’s item, even when one arrives', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(item({ ...TEAM_DESIGN, authorTrusted: false }));
      await fixture.whenStable();

      expect(root.querySelector('h2')?.textContent).toBe('Дизайн #20: экран дизайна и демо');
      for (const testId of ['github-title', 'question-text', 'outcomes', 'cost']) {
        expect(root.querySelector(`[data-testid="${testId}"]`), testId).toBeNull();
      }
    });

    it('renders hostile context as text, never as elements', async () => {
      const { fixture, root } = await render();
      fixture.componentInstance.item.set(
        item({
          ...TEAM_DESIGN,
          context: { ...CONTEXT, summary: HOSTILE, question: HOSTILE, why: HOSTILE, ifApproved: HOSTILE },
        }),
      );
      await fixture.whenStable();

      expect(root.querySelector('img, script')).toBeNull();
      expect(root.querySelector('h2')?.textContent).toBe(HOSTILE);
      expect(text(root, 'question-text')).toBe(HOSTILE);
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });
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

    it('never shows the raw answer line with its commands: it is the recommendation already (#275)', async () => {
      const { root } = await renderRich({
        body: '**Your answer:** /go (рекомендую) · /no-go что доделать\n<!-- pt-ask -->\n\nДемо: [стенд](https://example.com)',
        ask: '/go (рекомендую) · /no-go что доделать',
      });
      await new Promise((done) => setTimeout(done, 50));

      const details = root.querySelector('details')?.textContent ?? '';
      expect(details).toContain('стенд');
      expect(details).not.toContain('Your answer');
      expect(details).not.toContain('/no-go');
    });

    it('has no preview when the body links only to GitHub', async () => {
      const { root } = await renderRich({ body: 'See https://github.com/geeera/team-console/pull/9' });

      expect(root.querySelector('[data-testid="preview"]')).toBeNull();
    });
  });
});
