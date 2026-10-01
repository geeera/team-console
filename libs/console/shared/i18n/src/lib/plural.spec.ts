import { ApplicationInitStatus, ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { provideConsoleI18n } from './i18n.providers';
import { pluralCategoryOf, pluralKeyOf, TranslocoPluralPipe } from './plural';

describe('pluralCategoryOf', () => {
  it.each([
    [1, 'one'],
    [2, 'few'],
    [4, 'few'],
    [5, 'many'],
    [11, 'many'],
    [21, 'one'],
    [22, 'few'],
  ] as const)('ru %d → %s', (n, category) => {
    expect(pluralCategoryOf('ru', n)).toBe(category);
  });

  it.each([
    [1, 'one'],
    [0, 'other'],
    [2, 'other'],
    [5, 'other'],
  ] as const)('en %d → %s', (n, category) => {
    expect(pluralCategoryOf('en', n)).toBe(category);
  });

  it('builds the counted key', () => {
    expect(pluralKeyOf('settings.projects.row.missing', 'ru', 3)).toBe('settings.projects.row.missing.few');
  });
});

@Component({
  imports: [TranslocoPluralPipe],
  template: `<p>{{ 'settings.projects.row.missing' | translocoPlural: n() }}</p>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly n = signal(1);
}

describe('TranslocoPluralPipe', () => {
  it('renders the counted form and follows a language switch', async () => {
    TestBed.configureTestingModule({ imports: [Host], providers: [provideConsoleI18n()] });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    const text = (): string => (fixture.nativeElement as HTMLElement).textContent?.trim() ?? '';
    await fixture.whenStable();
    expect(text()).toBe('Не хватает 1 шага');

    fixture.componentInstance.n.set(5);
    await fixture.whenStable();
    expect(text()).toBe('Не хватает 5 шагов');

    const transloco = TestBed.inject(TranslocoService);
    transloco.setActiveLang('en');
    await firstValueFrom(transloco.load('en'));
    await fixture.whenStable();
    expect(text()).toBe('5 steps missing');
  });
});
