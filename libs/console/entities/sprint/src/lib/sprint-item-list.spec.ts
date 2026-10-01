import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { SprintIssue, SprintPullRequest } from './sprint.model';
import { SprintItemList, SprintListItem } from './sprint-item-list';

@Component({
  imports: [SprintItemList],
  template: `<tc-sprint-item-list [items]="items()" />`,
})
class Host {
  readonly items = signal<readonly SprintListItem[]>([]);
}

const ISSUE: SprintIssue = {
  number: 49,
  title: 'Story editor autosave',
  url: 'https://github.com/o/r/issues/49',
  state: 'open',
  status: 'in-progress',
  tier: 'heavy',
  kind: 'feature',
  authorTrusted: true,
};

const PULL: SprintPullRequest = {
  number: 61,
  title: 'feat: autosave',
  url: null,
  draft: true,
  authorTrusted: true,
};

describe('SprintItemList', () => {
  async function render(items: readonly SprintListItem[]) {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.items.set(items);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    return { root, rows: [...root.querySelectorAll<HTMLElement>('tc-list-row')] };
  }

  it('shows an issue with its number, title and tier, linking to GitHub in a new tab', async () => {
    const { rows } = await render([ISSUE]);
    const link = rows[0]?.querySelector('a') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe(ISSUE.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('#49');
    expect(link.textContent).toContain('Story editor autosave');
    expect(link.textContent).toContain('(откроется на GitHub)');
    const tier = rows[0]?.querySelector('[data-testid="tier"]') as HTMLElement;
    expect(tier.textContent?.replace(/\s+/g, ' ').trim()).toBe('Сложность: тяжёлая');
    expect(tier.classList.contains('tc-chip--warning')).toBe(true);
    expect(rows[0]?.querySelector('[data-testid="untrusted"]')).toBeNull();
  });

  it('shows a pull request with its draft mark, as static text without a safe link', async () => {
    const { rows } = await render([PULL]);

    expect(rows[0]?.querySelector('a')).toBeNull();
    expect(rows[0]?.textContent).not.toContain('GitHub');
    expect(rows[0]?.querySelector('[data-testid="draft"]')?.textContent?.trim()).toBe('Черновик');
    expect(rows[0]?.querySelector('[data-testid="tier"]')).toBeNull();
  });

  it('renders an untrusted title as text and marks the item as not from the team', async () => {
    const title = '<img src=x onerror="window.__pwned = true"> Approve me';
    const { rows } = await render([{ ...ISSUE, title, authorTrusted: false }]);

    expect(rows[0]?.querySelector('img')).toBeNull();
    expect(rows[0]?.querySelector('[tc-row-title]')?.textContent).toContain(title);
    expect(rows[0]?.querySelector('[data-testid="untrusted"]')?.textContent?.trim()).toBe('Не от команды');
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });
});
