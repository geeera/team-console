import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ApplicationInitStatus, Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { firstValueFrom } from 'rxjs';
import { ConfirmFailure } from './confirm-dialog';
import { Sheet } from './sheet';
import { SheetFooter } from './sheet-footer';

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

  it('hasOpen() says whether any sheet is open (#306)', async () => {
    expect(sheet.hasOpen()).toBe(false);

    const ref = sheet.open(Content, { title: 'Projects', data: { text: 'hello' } });
    await settle();
    expect(sheet.hasOpen()).toBe(true);

    ref.close();
    await settle();
    expect(sheet.hasOpen()).toBe(false);
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

    it('#114: shows the points and the field, passes the trimmed value, says why it failed and offers Try again', async () => {
      const seen: string[] = [];
      const pending = sheet.confirm({
        title: 'Pause?',
        message: '',
        items: ['Runs exit at once.', 'Questions stay.'],
        warning: 'Check the run log first.',
        input: { label: 'Reason', hint: 'Goes into the run log.', maxLength: 300 },
        confirmLabel: 'Pause',
        retryLabel: 'Try again',
        action: async (value) => {
          seen.push(value);
          if (seen.length === 1) {
            throw new ConfirmFailure('Run limit reached; try at 14:00.');
          }
        },
      });
      await settle();
      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect([...dialog.querySelectorAll('.tc-confirm__items li')].map((li) => li.textContent)).toEqual([
        'Runs exit at once.',
        'Questions stay.',
      ]);
      expect(dialog.querySelector('.tc-confirm__warning')?.textContent?.trim()).toBe(
        'Check the run log first.',
      );
      const input = dialog.querySelector('input') as HTMLInputElement;
      expect(dialog.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Reason');
      expect(input.getAttribute('maxlength')).toBe('300');
      input.value = '  отпуск  ';
      input.dispatchEvent(new Event('input'));

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      TestBed.tick();
      expect(seen).toEqual(['отпуск']);
      expect(dialog.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'Run limit reached; try at 14:00.',
      );
      const ok = dialog.querySelector('.tc-confirm__ok') as HTMLButtonElement;
      expect(ok.textContent?.trim()).toBe('Try again');

      ok.click();
      await expect(pending).resolves.toBe(true);
      expect(seen).toEqual(['отпуск', 'отпуск']);
    });

    it('#218: a checked date field follows the value, holds Confirm on an error and refills on a conflict', async () => {
      const seen: string[] = [];
      const pending = sheet.confirm({
        title: 'Move the demo?',
        message: 'The demo is on 14 October.',
        input: {
          label: 'Demo date',
          type: 'date',
          value: '2026-10-14',
          min: '2026-10-05',
          check: (value) =>
            value < '2026-10-05'
              ? { error: 'That date has passed.' }
              : value === '2026-10-14'
                ? { hint: 'Freeze: 12–14 October', confirmLabel: 'The date has not changed', isBlocked: true }
                : {
                    hint: `Freeze ends ${value}`,
                    confirmLabel: `Move to ${value}`,
                    ...(value <= '2026-10-07' ? { warning: 'Freeze starts at once.' } : {}),
                  },
        },
        confirmLabel: 'Move',
        action: async (value) => {
          seen.push(value);
          if (seen.length === 1) {
            throw new ConfirmFailure('The date changed meanwhile (now 15 October).', '2026-10-15');
          }
        },
      });
      await settle();
      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      const input = dialog.querySelector('input') as HTMLInputElement;
      const ok = dialog.querySelector('.tc-confirm__ok') as HTMLButtonElement;
      const region = (): HTMLElement => dialog.querySelector(`#${input.id}-hint`) as HTMLElement;
      const pick = async (value: string): Promise<void> => {
        input.value = value;
        input.dispatchEvent(new Event('change'));
        await settle();
        TestBed.tick();
      };
      TestBed.tick();
      expect(input.type).toBe('date');
      expect(input.value).toBe('2026-10-14');
      expect(input.getAttribute('min')).toBe('2026-10-05');
      expect(input.getAttribute('aria-describedby')).toBe(`${input.id}-hint`);
      expect(region().getAttribute('aria-live')).toBe('polite');
      expect(region().textContent?.trim()).toBe('Freeze: 12–14 October');
      expect(ok.textContent?.trim()).toBe('The date has not changed');
      expect(ok.getAttribute('aria-disabled')).toBe('true');
      ok.click();
      await settle();
      expect(seen).toEqual([]);

      await pick('2026-10-01');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(region().querySelector('.tc-confirm__invalid')?.textContent?.trim()).toBe('That date has passed.');
      ok.click();
      await settle();
      expect(seen).toEqual([]);

      await pick('2026-10-06');
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(region().querySelector('.tc-confirm__caution')?.textContent?.trim()).toBe('Freeze starts at once.');
      expect(ok.textContent?.trim()).toBe('Move to 2026-10-06');

      ok.click();
      await settle();
      TestBed.tick();
      expect(seen).toEqual(['2026-10-06']);
      expect(dialog.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The date changed meanwhile (now 15 October).',
      );
      expect(input.value).toBe('2026-10-15');
      expect(ok.textContent?.trim()).toBe('Повторить');

      ok.click();
      await expect(pending).resolves.toBe(true);
      expect(seen).toEqual(['2026-10-06', '2026-10-15']);
    });
  });

  describe('one shell: viewport, actions and scroll lock (#274)', () => {
    it('puts the confirmation buttons in the footer, outside the scrolling body, Confirm first', async () => {
      void sheet.confirm({ title: 'Archive?', message: 'It stays readable.', confirmLabel: 'Archive' });
      await settle();
      TestBed.tick();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      const foot = dialog.querySelector('.tc-sheet__foot') as HTMLElement;
      const buttons = Array.from(foot.querySelectorAll('button')).map((button) => button.className);
      expect(buttons[0]).toContain('tc-confirm__ok');
      expect(buttons[1]).toContain('tc-confirm__cancel');
      expect(dialog.querySelector('.tc-sheet__body')?.contains(foot)).toBe(false);
    });

    it('locks the page while a sheet is open and keeps only the top sheet of a stack scrollable', async () => {
      const root = document.documentElement;
      expect(root.hasAttribute('data-tc-scroll-lock')).toBe(false);

      const below = sheet.open(Content, { title: 'Commands', data: { text: 'panel' } });
      await settle();
      expect(root.hasAttribute('data-tc-scroll-lock')).toBe(true);

      const above = sheet.open(Content, { title: 'Ask the PM', data: { text: 'form' } });
      await settle();
      const panes = Array.from(overlay().querySelectorAll('.cdk-overlay-pane'));
      expect(panes.map((pane) => pane.classList.contains('tc-overlay-covered'))).toEqual([true, false]);

      above.close();
      await settle();
      expect(overlay().querySelector('.cdk-overlay-pane')?.classList).not.toContain('tc-overlay-covered');
      expect(root.hasAttribute('data-tc-scroll-lock')).toBe(true);

      below.close();
      await settle();
      expect(root.hasAttribute('data-tc-scroll-lock')).toBe(false);
    });
  });

  describe('footer and width (#194)', () => {
    it('renders the content footer outside the scrolling body, and drops it with the content', async () => {
      const ref = sheet.open(WithFooter, { title: 'Add geeera/storify', data: { text: 'checklist' } });
      await settle();
      TestBed.tick();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      const foot = dialog.querySelector('.tc-sheet__foot') as HTMLElement;
      expect(foot.querySelector('.done')?.textContent).toBe('Done');
      expect(dialog.querySelector('.tc-sheet__body')?.contains(foot)).toBe(false);
      expect(dialog.classList).toContain('tc-sheet--with-foot');

      const closed = firstValueFrom(ref.closed);
      (foot.querySelector('.done') as HTMLButtonElement).click();
      await expect(closed).resolves.toBe('done');
    });

    it('has no footer row for content without one, and a body that fits adds no tab stop', async () => {
      sheet.open(Content, { title: 'Projects', data: { text: 'hello' } });
      await settle();
      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(dialog.querySelector('.tc-sheet__foot')).toBeNull();
      const body = dialog.querySelector('.tc-sheet__body') as HTMLElement;
      expect(body.getAttribute('tabindex')).toBeNull();
      expect(body.getAttribute('role')).toBeNull();
    });

    it('gives a wide dialog its own panel class', async () => {
      sheet.open(Content, { title: 'Add', data: { text: 'x' }, width: 'wide' });
      await settle();
      const panel = overlay().querySelector('.cdk-overlay-pane') as HTMLElement;
      // jsdom matches no phone breakpoint, so this is the centred dialog.
      expect(panel.classList).toContain('tc-dialog-panel');
      expect(panel.classList).toContain('tc-dialog-panel--wide');
    });

    it('gives a full-size dialog its own panel and frame classes, over width (#277)', async () => {
      sheet.open(Content, { title: 'Design', data: { text: 'x' }, size: 'full', width: 'wide' });
      await settle();
      const panel = overlay().querySelector('.cdk-overlay-pane') as HTMLElement;
      expect(panel.classList).toContain('tc-dialog-panel');
      expect(panel.classList).toContain('tc-dialog-panel--full');
      expect(panel.classList).not.toContain('tc-dialog-panel--wide');
      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(dialog.classList).toContain('tc-sheet--full');
      // The body no longer scrolls, so it is never a tab stop; the content owns the scroller.
      expect(dialog.querySelector('.tc-sheet__body')?.getAttribute('tabindex')).toBeNull();
    });
  });
});

@Component({
  imports: [SheetFooter],
  template: `<p class="content">{{ data.text }}</p>
    <ng-template tcSheetFooter>
      <button type="button" class="done" (click)="ref.close('done')">Done</button>
    </ng-template>`,
})
class WithFooter {
  readonly data = inject<{ text: string }>(DIALOG_DATA);
  readonly ref = inject(DialogRef);
}
