import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Artifact } from './artifact.model';
import { ArtifactList } from './artifact-list';

@Component({
  imports: [ArtifactList],
  template: `<tc-artifact-list
    [items]="items()"
    [grouped]="grouped()"
    label="Artifacts"
    [designLeading]="leading"
    [designSubtitle]="subtitle"
    (openDesign)="opened.set($event.number)"
  />
    <ng-template #leading let-design><span class="thumb">thumb {{ design.number }}</span></ng-template>
    <ng-template #subtitle let-design><span class="summary">#{{ design.number }} · 6 экранов</span></ng-template>`,
})
class Host {
  readonly items = signal<readonly Artifact[]>([]);
  readonly grouped = signal(false);
  readonly opened = signal<number | null>(null);
}

const DESIGN: Artifact = {
  type: 'design',
  title: '<img src=x onerror=alert(1)> Settings',
  url: 'https://github.com/o/r/issues/24',
  updatedAt: '2026-09-20T00:00:00Z',
  source: 'issue',
  state: 'closed',
};

function many(count: number): Artifact[] {
  return Array.from({ length: count }, (_, index) => ({
    ...DESIGN,
    title: `Design ${index}`,
    url: `${DESIGN.url}${index}`,
  }));
}

describe('ArtifactList', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return fixture;
  }

  it('renders a title as text and links to its github.com page in a new tab', async () => {
    const fixture = await render();
    fixture.componentInstance.items.set([DESIGN]);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const link = root.querySelector('a') as HTMLAnchorElement;

    expect(link.getAttribute('href')).toBe(DESIGN.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(root.querySelector('img')).toBeNull();
    expect(link.textContent).toContain('<img src=x onerror=alert(1)> Settings');
    // Direction from the title itself, isolated from the row (#287).
    expect(link.querySelector('[tc-row-title]')?.getAttribute('dir')).toBe('auto');
    expect(link.textContent).toContain('(откроется на GitHub)');
    expect(root.textContent).toContain('Дизайн');
    expect(root.textContent).toContain('закрыта');
  });

  it('renders a design issue as a button row with the thumbnail and summary slots, and opens it (#277)', async () => {
    const fixture = await render();
    fixture.componentInstance.items.set([{ ...DESIGN, state: 'open', number: 277, awaitingApproval: true }]);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const row = root.querySelector('[data-testid="artifact"]') as HTMLElement;
    const button = row.querySelector('button') as HTMLButtonElement;

    expect(row.getAttribute('data-issue')).toBe('277');
    expect(root.querySelector('a')).toBeNull();
    expect(button.textContent).toContain('<img src=x onerror=alert(1)> Settings');
    expect(button.textContent).toContain('Открыть дизайн');
    expect(button.querySelector('.thumb')?.textContent).toBe('thumb 277');
    expect(button.querySelector('.summary')?.textContent).toBe('#277 · 6 экранов');
    expect(row.querySelector('[data-testid="artifact-awaiting"]')?.textContent?.trim()).toBe(
      'Ждёт вашего согласования',
    );
    expect(root.querySelector('img')).toBeNull();

    button.click();
    expect(fixture.componentInstance.opened()).toBe(277);
  });

  it('keeps a design issue without a number, and a design file, as plain GitHub links', async () => {
    const fixture = await render();
    fixture.componentInstance.items.set([DESIGN, { ...DESIGN, source: 'file', state: null, updatedAt: null }]);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('a')).toHaveLength(2);
    expect(root.querySelector('button')).toBeNull();
  });

  // No wall-clock budget here: jsdom timing does not hold on CI runners (filterArtifacts carries the perf check).
  it('tracks 250 rows by artifact, so a new list with the same artifacts reuses every row', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    fixture.componentInstance.items.set(many(250));
    fixture.detectChanges();
    const before = [...root.querySelectorAll('[data-testid="artifact"]')];

    fixture.componentInstance.items.set(
      many(250).map((item) => ({ ...item, title: `${item.title} renamed` })),
    );
    fixture.detectChanges();
    const after = [...root.querySelectorAll('[data-testid="artifact"]')];

    expect(after).toHaveLength(250);
    expect(after.every((row, index) => row === before[index])).toBe(true);
    expect(after[0]?.textContent).toContain('Design 0 renamed');
  });

  it('opens each type with an eye-only heading and its count when grouped; the list counts the artifacts alone (#766)', async () => {
    const fixture = await render();
    const decision: Artifact = { ...DESIGN, type: 'decision', source: 'file', state: null, url: 'https://github.com/o/r/blob/main/0001.md' };
    fixture.componentInstance.items.set([decision, { ...decision, url: `${decision.url}2` }, { ...DESIGN, number: 24 }]);
    fixture.componentInstance.grouped.set(true);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const groups = Array.from(root.querySelectorAll('[data-testid="artifact-group"]'));
    expect(groups.map((group) => group.getAttribute('data-type'))).toEqual(['decision', 'design']);
    expect(groups[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(groups[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Решения 2');
    expect(root.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    expect(root.querySelector('tc-list')?.classList).toContain('tc-list--grid');

    fixture.componentInstance.grouped.set(false);
    await fixture.whenStable();
    expect(root.querySelectorAll('[data-testid="artifact-group"]')).toHaveLength(0);
  });

  it('gives a link card a kicker with its type in the singular, hidden from screen readers (#766)', async () => {
    const fixture = await render();
    fixture.componentInstance.items.set([{ ...DESIGN, type: 'decision', source: 'file', state: null }]);
    await fixture.whenStable();
    const kicker = (fixture.nativeElement as HTMLElement).querySelector('a [tc-row-kicker]');
    expect(kicker?.getAttribute('aria-hidden')).toBe('true');
    expect(kicker?.textContent?.trim()).toBe('Решение');
  });
});
