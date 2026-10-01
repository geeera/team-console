import { DIALOG_DATA } from '@angular/cdk/dialog';
import { ApplicationInitStatus, Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet } from './sheet';

@Component({
  template: `<p class="content">{{ data.text }}</p>
    <button type="button" class="inside">Inside</button>`,
})
class Content {
  readonly data = inject<{ text: string }>(DIALOG_DATA);
}

@Component({ template: `<button type="button" class="opener">Open</button>` })
class Host {}

function overlay(): HTMLElement {
  return document.querySelector('.cdk-overlay-container') as HTMLElement;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Sheet', () => {
  let sheet: Sheet;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    sheet = TestBed.inject(Sheet);
  });

  afterEach(() => {
    overlay()?.remove();
  });

  it('opens a labelled modal dialog with the content and its data', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();

    const ref = sheet.open(Content, { title: 'Projects', data: { text: 'hello' } });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(titleId)?.textContent?.trim()).toBe('Projects');
    expect(dialog.querySelector('.content')?.textContent).toBe('hello');
    expect(dialog.querySelector('.tc-sheet__close')?.getAttribute('aria-label')).toBe('Закрыть');

    ref.close();
    await settle();
    expect(overlay().querySelector('tc-sheet-container')).toBeNull();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const opener = (fixture.nativeElement as HTMLElement).querySelector('.opener') as HTMLButtonElement;
    document.body.appendChild(fixture.nativeElement);
    opener.focus();

    const ref = sheet.open(Content, { title: 'Projects', data: { text: 'hello' } });
    await settle();
    let closed = false;
    ref.closed.subscribe(() => (closed = true));

    overlay()
      .querySelector('tc-sheet-container')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await settle();

    expect(closed).toBe(true);
    expect(document.activeElement).toBe(opener);
    fixture.nativeElement.remove();
  });

  it('confirm() resolves true on Confirm and false on Cancel, focusing Cancel first', async () => {
    const pending = sheet.confirm({ title: 'Archive?', message: 'Sure?', confirmLabel: 'Archive' });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    const cancel = dialog.querySelector('.tc-confirm__cancel') as HTMLButtonElement;
    const ok = dialog.querySelector('.tc-confirm__ok') as HTMLButtonElement;
    expect(cancel.textContent?.trim()).toBe('Отмена');
    expect(ok.textContent?.trim()).toBe('Archive');
    expect(document.activeElement).toBe(cancel);

    ok.click();
    await expect(pending).resolves.toBe(true);

    const declined = sheet.confirm({ title: 'Archive?', message: 'Sure?' });
    await settle();
    (overlay().querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
    await expect(declined).resolves.toBe(false);
  });

  it('confirm() describes the dialog with its message and shows the note', async () => {
    const pending = sheet.confirm({
      title: 'Archive?',
      message: 'It leaves the list.',
      note: 'GitHub stays.',
    });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('It leaves the list.');
    expect(dialog.querySelector('.tc-confirm__note')?.textContent).toBe('GitHub stays.');

    (dialog.querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });

  describe('confirm() with an action', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const escape = (): void => {
      overlay()
        .querySelector('tc-sheet-container')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    };

    it('stays open and busy while the action runs, ignoring Escape, then resolves true', async () => {
      const work = deferred();
      const pending = sheet.confirm({
        title: 'Archive?',
        message: 'Sure?',
        confirmLabel: 'Archive',
        busyLabel: 'Archiving…',
        action: () => work.promise,
      });
      await settle();
      const ok = overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement;

      ok.click();
      await settle();
      TestBed.tick();
      expect(ok.textContent?.trim()).toBe('Archiving…');
      expect(ok.getAttribute('aria-disabled')).toBe('true');
      escape();
      (overlay().querySelector('.tc-sheet__close') as HTMLButtonElement).click();
      await settle();
      expect(overlay().querySelector('tc-sheet-container')).not.toBeNull();

      work.resolve();
      await expect(pending).resolves.toBe(true);
    });

    it('a failed action keeps the dialog open with an alert; Cancel then resolves false', async () => {
      const work = deferred();
      const pending = sheet.confirm({
        title: 'Archive?',
        message: 'Sure?',
        errorMessage: 'Could not archive.',
        action: () => work.promise,
      });
      await settle();
      (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
      work.reject(new Error('offline'));
      await settle();
      TestBed.tick();

      expect(overlay().querySelector('[role="alert"]')?.textContent?.trim()).toBe('Could not archive.');
      expect(overlay().querySelector('tc-sheet-container')).not.toBeNull();

      (overlay().querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
      await expect(pending).resolves.toBe(false);
    });
  });
});
