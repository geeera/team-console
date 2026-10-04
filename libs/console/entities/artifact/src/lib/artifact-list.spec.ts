import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Artifact } from './artifact.model';
import { ArtifactList } from './artifact-list';

@Component({
  imports: [ArtifactList],
  template: `<tc-artifact-list [items]="items()" label="Artifacts" />`,
})
class Host {
  readonly items = signal<readonly Artifact[]>([]);
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
    expect(link.textContent).toContain('(откроется на GitHub)');
    expect(root.textContent).toContain('Дизайн');
    expect(root.textContent).toContain('закрыта');
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
});
