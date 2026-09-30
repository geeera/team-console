import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { OverviewPage } from './overview.page';

describe('OverviewPage', () => {
  it('renders the titled placeholder in both languages', async () => {
    await TestBed.configureTestingModule({
      imports: [OverviewPage],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(OverviewPage);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Все проекты');
    expect(root.querySelector('tc-state-block')).not.toBeNull();

    TestBed.inject(TranslocoService).setActiveLang('en');
    await fixture.whenStable();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('All projects');
  });
});
