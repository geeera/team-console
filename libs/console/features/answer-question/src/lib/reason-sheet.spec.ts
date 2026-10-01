import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { firstValueFrom } from 'rxjs';
import { ReasonSheet, ReasonSheetData } from './reason-sheet';

function overlay(): HTMLElement {
  return document.querySelector('.cdk-overlay-container') as HTMLElement;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ReasonSheet', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideConsoleI18n()] }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });

  afterEach(() => overlay()?.remove());

  function open(data: ReasonSheetData) {
    const ref = TestBed.inject(Sheet).open<string, ReasonSheetData>(ReasonSheet, {
      title: 'Why?',
      data,
      autoFocus: 'textarea',
    });
    return { ref, closed: firstValueFrom(ref.closed) };
  }

  it('will not close without a reason; the error is announced on the labelled field', async () => {
    const { ref, closed } = open({ command: 'reject' });
    await settle();
    const textarea = overlay().querySelector('textarea') as HTMLTextAreaElement;
    const submit = overlay().querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(document.activeElement).toBe(textarea);
    expect(overlay().querySelector(`label[for="${textarea.id}"]`)?.textContent).toContain('Причина');
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    submit.click();
    await settle();

    expect(overlay().querySelector('[role="alert"]')?.textContent).toContain('Напиши причину');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    textarea.value = '  Нет бюджета  ';
    textarea.dispatchEvent(new Event('input'));
    submit.click();
    await expect(closed).resolves.toBe('Нет бюджета');
    expect(ref).toBeDefined();
  });

  it('override shows the warning and an explicit confirm button; Cancel closes with nothing', async () => {
    const { closed } = open({ command: 'override' });
    await settle();

    expect(overlay().querySelector('[data-testid="override-warning"]')?.textContent).toContain(
      'в обход проверок',
    );
    expect(overlay().querySelector('button[type="submit"]')?.textContent?.trim()).toBe(
      'Подтвердить и выпустить',
    );
    (overlay().querySelector('button[type="button"]:not(.tc-sheet__close)') as HTMLButtonElement).click();
    await expect(closed).resolves.toBeUndefined();
  });
});
