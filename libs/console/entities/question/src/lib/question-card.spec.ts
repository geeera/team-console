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
  template: `<tc-question-card [item]="item()" [showProject]="showProject()"
    ><button tc-question-actions type="button">Act</button></tc-question-card
  >`,
})
class Host {
  readonly item = signal(item());
  readonly showProject = signal(true);
}

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
    expect(root.querySelector('.question__body')?.textContent).toBe(item().body);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
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
});
