import { ApplicationInitStatus } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideAppConfig } from '@console/shared/config';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { HelloPage } from './hello.page';

describe('HelloPage', () => {
  let fixture: ComponentFixture<HelloPage>;
  let transloco: TranslocoService;

  const text = (selector: string): string =>
    (fixture.nativeElement as HTMLElement).querySelector(selector)?.textContent?.trim() ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HelloPage],
      providers: [
        provideConsoleI18n(),
        provideAppConfig({ name: 'Team Console', version: '0.1.0', builtAt: '2026-09-29T10:00:00.000Z' }),
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    transloco = TestBed.inject(TranslocoService);
    fixture = TestBed.createComponent(HelloPage);
    await fixture.whenStable();
  });

  it('renders the Russian title by default inside a landmark with one heading', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('main')).not.toBeNull();
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(text('h1')).toBe('Привет, консоль');
  });

  it('renders the English title after setActiveLang("en")', async () => {
    transloco.setActiveLang('en');
    await fixture.whenStable();

    expect(text('h1')).toBe('Hello, console');
  });

  it('shows version and build time from the app-info entity', () => {
    expect(text('[data-testid="app-version"]')).toBe('0.1.0');
    expect(text('[data-testid="app-built-at"]')).toBe('2026-09-29T10:00:00.000Z');
  });

  it('offers the other language on a button labelled in that language', async () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('English');
    expect(button.lang).toBe('en');

    button.click();
    await fixture.whenStable();

    expect(transloco.getActiveLang()).toBe('en');
    expect(button.textContent?.trim()).toBe('Русский');
    expect(button.lang).toBe('ru');
  });
});
