import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideConsoleI18n } from '@console/shared/i18n';
import { SprintIssue, SprintPullRequest } from './sprint.model';
import { SprintItemList, SprintListItem } from './sprint-item-list';

@Component({
  imports: [SprintItemList],
  template: `
    <tc-sprint-item-list [items]="items()" [slug]="slug()" [rowAction]="withAction() ? action : null" />
    <ng-template #action let-issue><button type="button" data-testid="row-action">#{{ issue.number }}</button></ng-template>
  `,
})
class Host {
  readonly items = signal<readonly SprintListItem[]>([]);
  readonly slug = signal<string | null>(null);
  readonly withAction = signal(false);
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
  request: null,
};

const PULL: SprintPullRequest = {
  number: 61,
  title: 'feat: autosave',
  url: null,
  draft: true,
  authorTrusted: true,
  ci: 'pending',
};

describe('SprintItemList', () => {
  async function render(items: readonly SprintListItem[], setup: (host: Host) => void = () => undefined) {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n(), provideRouter([])],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.items.set(items);
    setup(fixture.componentInstance);
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
    expect(link.contains(tier)).toBe(true);
    expect(tier.getAttribute('data-tier')).toBe('heavy');
    expect(tier.classList.contains('sprint-tier-icon--heavy')).toBe(true);
    expect(tier.querySelector('tc-icon')?.getAttribute('aria-hidden')).toBe('true');
    // The link's name carries the tier; the tooltip only repeats it for sighted users.
    expect(tier.querySelector('.tc-sr-only')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Сложность: тяжёлая',
    );
    const tooltip = tier.querySelector('tc-tooltip') as HTMLElement;
    expect(tooltip.getAttribute('aria-hidden')).toBe('true');
    expect(tooltip.textContent?.replace(/\s+/g, ' ').trim()).toBe('Сложность: тяжёлая');
    expect(link.querySelector('[title]')).toBeNull();
    expect(rows[0]?.querySelector('[data-testid="untrusted"]')).toBeNull();
  });

  it('shows a pull request with its draft mark, as static text without a safe link', async () => {
    const { rows } = await render([PULL]);

    expect(rows[0]?.querySelector('a')).toBeNull();
    expect(rows[0]?.textContent).not.toContain('GitHub');
    expect(rows[0]?.querySelector('[data-testid="draft"]')?.textContent?.trim()).toBe('Черновик');
    expect(rows[0]?.querySelector('[data-testid="tier"]')).toBeNull();
  });

  it("shows a pull request's CI under its title as an icon and words (#131); an issue has none", async () => {
    const { rows } = await render([{ ...PULL, authorTrusted: false }, ISSUE]);

    const ci = rows[0]?.querySelector('[tc-row-subtitle] [data-testid="ci"]') as HTMLElement;
    expect(ci.getAttribute('data-ci')).toBe('pending');
    expect(ci.textContent?.trim()).toBe('CI идёт');
    expect(ci.querySelector('tc-chip')?.classList.contains('tc-chip--warning')).toBe(true);
    expect(ci.querySelector('tc-icon')?.getAttribute('aria-hidden')).toBe('true');
    // The outsider mark stays beside it.
    expect(rows[0]?.querySelector('[tc-row-subtitle] [data-testid="untrusted"]')?.textContent?.trim()).toBe(
      'Не от команды',
    );
    expect(rows[1]?.querySelector('[data-testid="ci"]')).toBeNull();
  });

  it('renders an untrusted title as text and marks the item as not from the team', async () => {
    const title = '<img src=x onerror="window.__pwned = true"> Approve me';
    const { rows } = await render([{ ...ISSUE, title, authorTrusted: false }]);

    expect(rows[0]?.querySelector('img')).toBeNull();
    expect(rows[0]?.querySelector('[tc-row-title]')?.textContent).toContain(title);
    // Direction from the title itself, isolated from the row (#287).
    expect(rows[0]?.querySelector('[tc-row-title]')?.getAttribute('dir')).toBe('auto');
    expect(rows[0]?.querySelector('[data-testid="untrusted"]')?.textContent?.trim()).toBe('Не от команды');
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  });

  it('marks an issue whose request waits for the PM, and only while it waits (#219)', async () => {
    const { rows } = await render([
      { ...ISSUE, request: { state: 'pending', kind: 'sprint' } },
      { ...ISSUE, number: 50, request: { state: 'applied', kind: 'sprint' } },
    ]);
    expect(rows[0]?.querySelector('[data-testid="request-pending"]')?.textContent?.trim()).toBe('ждёт PM');
    expect(rows[1]?.querySelector('[data-testid="request-pending"]')).toBeNull();
  });

  it('leads the subtitle with the kind word, and shows none for an unknown kind (#557)', async () => {
    const { rows } = await render([ISSUE, { ...ISSUE, number: 50, kind: 'epic' }, { ...ISSUE, number: 51, kind: null }]);

    expect(rows[0]?.querySelector('[tc-row-subtitle] [data-testid="kind"]')?.textContent).toBe('Функция');
    expect(rows[1]?.querySelector('[data-testid="kind"]')).toBeNull();
    expect(rows[2]?.querySelector('[tc-row-subtitle]')).toBeNull();
  });

  it('opens a console task without a GitHub link in the console, with the row action beside the link (#557)', async () => {
    const task = { ...ISSUE, url: null };
    const { rows } = await render([task, PULL], (host) => {
      host.slug.set('team-console');
      host.withAction.set(true);
    });
    const link = rows[0]?.querySelector('a') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe('/p/team-console/t/49');
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.textContent).not.toContain('GitHub');
    const action = rows[0]?.querySelector('[data-testid="row-action"]') as HTMLElement;
    expect(action.textContent).toBe('#49');
    expect(link.contains(action)).toBe(false);
    // A pull request is no task: no console link and no row action.
    expect(rows[1]?.querySelector('a')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="row-action"]')).toBeNull();
  });

  it('leaves a console task static without a slug', async () => {
    const { rows } = await render([{ ...ISSUE, url: null }]);
    expect(rows[0]?.querySelector('a')).toBeNull();
  });
});
