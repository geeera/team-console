import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { ApplicationInitStatus, Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideConsoleI18n } from '@console/shared/i18n';
import { firstValueFrom } from 'rxjs';
import { ConfirmFailure } from './confirm-dialog';
import { OpenSheets } from './open-sheets';
import { Sheet } from './sheet';
import { SheetCloseGuard } from './sheet-close-guard';
import { SheetFooter } from './sheet-footer';

@Component({
  template: `<p class="content">{{ data.text }}</p>
    <button type="button" class="inside">Inside</button>`,
})
class Content {
  readonly data = inject<{ text: string }>(DIALOG_DATA);
}

@Component({ template: `<p>guarded</p>` })
class Guarded {
  readonly ref = inject(DialogRef);
  readonly asked = signal(0);

  constructor() {
    this.ref.disableClose = true;
    inject(SheetCloseGuard).intercept(() => this.asked.update((count) => count + 1));
  }
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
      providers: [provideConsoleI18n(), provideRouter([{ path: 'fix', children: [] }])],
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

  it('closeAll() closes every open sheet, a busy confirmation too, and unlocks the page (#367)', async () => {
    const below = sheet.open(Content, { title: 'Commands', data: { text: 'panel' } });
    const pending = sheet.confirm({
      title: 'Pause?',
      message: 'Sure?',
      action: () => new Promise<void>(() => undefined),
    });
    await settle();
    (overlay().querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
    await settle();
    let belowResult: unknown = 'open';
    below.closed.subscribe((result) => (belowResult = result));

    sheet.closeAll();
    await settle();

    expect(sheet.hasOpen()).toBe(false);
    expect(overlay().querySelector('tc-sheet-container')).toBeNull();
    expect(belowResult).toBeUndefined();
    await expect(pending).resolves.toBe(false);
    expect(document.documentElement.hasAttribute('data-tc-scroll-lock')).toBe(false);
  });

  it('OpenSheets.closeAll() closes what Sheet opened, without the caller importing Sheet (#337)', async () => {
    const pending = sheet.confirm({ title: 'Pause?', message: 'Sure?' });
    await settle();
    expect(sheet.hasOpen()).toBe(true);

    TestBed.inject(OpenSheets).closeAll();
    await settle();

    expect(sheet.hasOpen()).toBe(false);
    expect(overlay().querySelector('tc-sheet-container')).toBeNull();
    await expect(pending).resolves.toBe(false);
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

  it('hands the close button, Escape and the scrim to a close guard instead of closing (#634 PR 4)', async () => {
    const ref = sheet.open<unknown, unknown>(Guarded, { title: 'Wizard' });
    await settle();
    const guarded = ref.componentInstance as Guarded;
    const container = overlay().querySelector('tc-sheet-container') as HTMLElement;

    (container.querySelector('.tc-sheet__close') as HTMLButtonElement).click();
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    (overlay().querySelector('.cdk-overlay-backdrop') as HTMLElement).click();
    await settle();
    expect(guarded.asked()).toBe(3);
    expect(overlay().querySelector('tc-sheet-container')).not.toBeNull();

    ref.close();
    await settle();
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

  it('confirm() with a link opens it in a new tab, between the message and the buttons, without closing (#370)', async () => {
    const pending = sheet.confirm({
      title: 'Answer an item from outside the team?',
      message: 'Read the item on GitHub first.',
      confirmLabel: 'Answer anyway',
      link: { label: 'Open #72 on GitHub', href: 'https://github.com/geeera/team-console/issues/72' },
      tone: 'danger',
    });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    const link = dialog.querySelector('[data-testid="confirm-link"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/geeera/team-console/issues/72');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Open #72 on GitHub');
    expect(link.textContent).toContain('(новая вкладка)');

    // Reading order (#282): the message, then the link, then the dialog's own buttons.
    const focusables = Array.from(
      dialog.querySelectorAll('.tc-confirm__message, [data-testid="confirm-link"], .tc-sheet__foot button'),
    );
    expect(focusables.indexOf(link)).toBeGreaterThan(
      focusables.findIndex((el) => el.classList.contains('tc-confirm__message')),
    );
    expect(focusables.indexOf(link)).toBeLessThan(focusables.findIndex((el) => el.tagName === 'BUTTON'));

    // Following the link is not an answer: the dialog stays open and open-sheets.
    link.click();
    await settle();
    expect(sheet.hasOpen()).toBe(true);

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

    it('#750: a refusal with a link offers the way out; following it closes every sheet and navigates', async () => {
      const below = sheet.open(Content, { title: 'Commands', data: { text: 'panel' } });
      const belowClosed = firstValueFrom(below.closed);
      const pending = sheet.confirm({
        title: 'Run QA now?',
        message: 'QA checks the open PRs.',
        action: async () => {
          throw new ConfirmFailure('Run now isn’t set up for QA.', undefined, {
            label: 'Set the token',
            route: ['/fix'],
          });
        },
      });
      await settle();
      const dialogs = overlay().querySelectorAll('tc-sheet-container');
      const dialog = dialogs[dialogs.length - 1] as HTMLElement;
      expect(dialog.querySelector('[data-testid="confirm-failure-link"]')).toBeNull();

      (dialog.querySelector('.tc-confirm__ok') as HTMLButtonElement).click();
      await settle();
      TestBed.tick();
      const link = dialog.querySelector('[data-testid="confirm-failure-link"]') as HTMLAnchorElement;
      expect(link.textContent?.trim()).toBe('Set the token');
      expect(link.getAttribute('href')).toBe('/fix');

      link.click();
      await settle();
      await expect(pending).resolves.toBe(false);
      await expect(belowClosed).resolves.toBeUndefined();
      expect(sheet.hasOpen()).toBe(false);
      expect(TestBed.inject(Router).url).toBe('/fix');
    });

    it('#218/#307: a checked date field follows the value, holds Confirm on an error and refills on a conflict', async () => {
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
      // Typed text is read on blur (#307), as the owner leaves the field for Confirm.
      const pick = async (value: string): Promise<void> => {
        input.value = value;
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('blur'));
        await settle();
        TestBed.tick();
      };
      await settle();
      TestBed.tick();
      expect(dialog.querySelector('input[type="date"]')).toBeNull();
      expect(dialog.querySelector('tc-date-picker')).not.toBeNull();
      expect(input.type).toBe('text');
      expect(input.value).toBe('14.10.2026');
      expect(dialog.querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBe('Demo date');
      expect(input.getAttribute('aria-describedby')).toBe(`${input.id}-hint`);
      expect(region().getAttribute('aria-live')).toBe('polite');
      expect(region().textContent?.trim()).toBe('Freeze: 12–14 October');
      expect(ok.textContent?.trim()).toBe('The date has not changed');
      expect(ok.getAttribute('aria-disabled')).toBe('true');
      ok.click();
      await settle();
      expect(seen).toEqual([]);

      await pick('31.02.2026');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(region().querySelector('.tc-confirm__invalid')?.textContent?.trim()).toMatch(/^Такой даты нет/);
      expect(input.value).toBe('31.02.2026');
      expect(ok.getAttribute('aria-disabled')).toBe('true');

      await pick('01.10.2026');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(region().querySelector('.tc-confirm__invalid')?.textContent?.trim()).toBe(
        'That date has passed.',
      );
      ok.click();
      await settle();
      expect(seen).toEqual([]);

      await pick('2026-10-06');
      expect(input.value).toBe('06.10.2026');
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(region().querySelector('.tc-confirm__caution')?.textContent?.trim()).toBe(
        'Freeze starts at once.',
      );
      expect(ok.textContent?.trim()).toBe('Move to 2026-10-06');

      ok.click();
      await settle();
      TestBed.tick();
      expect(seen).toEqual(['2026-10-06']);
      expect(dialog.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The date changed meanwhile (now 15 October).',
      );
      await settle();
      TestBed.tick();
      expect(input.value).toBe('15.10.2026');
      expect(ok.textContent?.trim()).toBe('Повторить');

      ok.click();
      await expect(pending).resolves.toBe(true);
      expect(seen).toEqual(['2026-10-06', '2026-10-15']);
    });
  });

  describe('one shell: viewport, actions and scroll lock (#274)', () => {
    it('puts the confirmation buttons in the footer, outside the scrolling body, in the dialog reading order (#282)', async () => {
      void sheet.confirm({ title: 'Archive?', message: 'It stays readable.', confirmLabel: 'Archive' });
      await settle();
      TestBed.tick();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      const foot = dialog.querySelector('.tc-sheet__foot') as HTMLElement;
      const buttons = Array.from(foot.querySelectorAll('button')).map((button) => button.className);
      expect(buttons[0]).toContain('tc-confirm__cancel');
      expect(buttons[1]).toContain('tc-confirm__ok');
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

    it('#282: in the dialog the footer lists the secondary before the primary, so Tab follows the row left to right', async () => {
      sheet.open(WithActions, { title: 'Snooze', data: { text: 'until' } });
      await settle();
      TestBed.tick();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(dialog.classList).toContain('tc-sheet--dialog');
      expect(dialog.classList).toContain('tc-sheet--with-foot');
      expect(footerButtons(dialog)).toEqual(['Cancel', 'Snooze']);
    });

    it('#282: a free-form footer keeps the order it was written in, before any role', async () => {
      sheet.open(WithMixedFooter, { title: 'Design', data: { text: 'x' } });
      await settle();
      TestBed.tick();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(footerButtons(dialog)).toEqual(['Prev', 'Next', 'Cancel', 'Save']);
    });

    it('#282: confirm() in the dialog puts Cancel first in the DOM and still focuses it first', async () => {
      const pending = sheet.confirm({ title: 'Archive?', message: 'Sure?', confirmLabel: 'Archive' });
      await settle();

      const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(footerButtons(dialog)).toEqual(['Отмена', 'Archive']);
      expect(document.activeElement).toBe(dialog.querySelector('.tc-confirm__cancel'));

      (dialog.querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
      await expect(pending).resolves.toBe(false);
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

/** Written primary first, as the phone shows it; the frame decides the DOM order per presentation (#282). */
@Component({
  imports: [SheetFooter],
  template: `<p class="content">{{ data.text }}</p>
    <ng-template tcSheetFooter="primary">
      <button type="button" class="ok">Snooze</button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button type="button" class="cancel">Cancel</button>
    </ng-template>`,
})
class WithActions {
  readonly data = inject<{ text: string }>(DIALOG_DATA);
}

@Component({
  imports: [SheetFooter],
  template: `<p class="content">{{ data.text }}</p>
    <ng-template tcSheetFooter="primary"><button type="button">Save</button></ng-template>
    <ng-template tcSheetFooter>
      <button type="button">Prev</button>
      <button type="button">Next</button>
    </ng-template>
    <ng-template tcSheetFooter="secondary"><button type="button">Cancel</button></ng-template>`,
})
class WithMixedFooter {
  readonly data = inject<{ text: string }>(DIALOG_DATA);
}

/** The footer's buttons as a reader meets them: DOM order, which the frame makes the visual order too. */
function footerButtons(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('.tc-sheet__foot button')).map((button) =>
    button.textContent?.trim(),
  );
}

describe('Sheet on the phone (#282)', () => {
  let sheet: Sheet;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), { provide: BreakpointObserver, useValue: { isMatched: () => true } }],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    sheet = TestBed.inject(Sheet);
  });

  afterEach(() => {
    overlay()?.remove();
  });

  it('stacks the primary over the secondary: the DOM order is the visual order here too', async () => {
    sheet.open(WithActions, { title: 'Snooze', data: { text: 'until' } });
    await settle();
    TestBed.tick();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.classList).not.toContain('tc-sheet--dialog');
    expect(footerButtons(dialog)).toEqual(['Snooze', 'Cancel']);
  });

  it('confirm() lists Confirm over Cancel and still focuses Cancel first', async () => {
    const pending = sheet.confirm({ title: 'Archive?', message: 'Sure?', confirmLabel: 'Archive' });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(footerButtons(dialog)).toEqual(['Archive', 'Отмена']);
    expect(document.activeElement).toBe(dialog.querySelector('.tc-confirm__cancel'));

    (dialog.querySelector('.tc-confirm__cancel') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });

  it('lifts the primary into the head beside the title with headAction; Close becomes text at the start (#107)', async () => {
    sheet.open(WithActions, {
      title: 'New task',
      subtitle: 'in storify',
      data: { text: 'form' },
      headAction: true,
    });
    await settle();
    TestBed.tick();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.classList).toContain('tc-sheet--head-action');
    const head = Array.from(dialog.querySelectorAll('.tc-sheet__head button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(head).toEqual(['Закрыть', 'Snooze']);
    expect(footerButtons(dialog)).toEqual(['Cancel']);
    const names = (dialog.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id));
    expect(names.map((el) => el?.textContent?.trim())).toEqual(['New task', 'in storify']);
  });

  it('drops the footer when the lifted primary was its only action', async () => {
    sheet.open(PrimaryOnly, { title: 'New task', headAction: true });
    await settle();
    TestBed.tick();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.querySelector('.tc-sheet__head .create')).not.toBeNull();
    expect(dialog.querySelector('.tc-sheet__foot')).toBeNull();
    expect(dialog.classList).not.toContain('tc-sheet--with-foot');
  });
});

@Component({
  imports: [SheetFooter],
  template: `<ng-template tcSheetFooter="primary"
    ><button type="button" class="create">Create</button></ng-template
  >`,
})
class PrimaryOnly {}

describe('Sheet as a dialog with the New task options (#107)', () => {
  let sheet: Sheet;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideConsoleI18n()] }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    sheet = TestBed.inject(Sheet);
  });

  afterEach(() => {
    overlay()?.remove();
  });

  it('keeps the primary in the footer and the close icon in the head: headAction is the phone only', async () => {
    sheet.open(WithActions, { title: 'New task', data: { text: 'form' }, headAction: true, width: 'task' });
    await settle();
    TestBed.tick();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.classList).not.toContain('tc-sheet--head-action');
    expect(dialog.querySelector('.tc-sheet__head .tc-sheet__close')?.getAttribute('aria-label')).toBe(
      'Закрыть',
    );
    expect(footerButtons(dialog)).toEqual(['Cancel', 'Snooze']);
    const panel = overlay().querySelector('.cdk-overlay-pane') as HTMLElement;
    expect(panel.classList).toContain('tc-dialog-panel--task');
  });

  it('follows a subtitle given as a signal, e.g. the project the form now creates in', async () => {
    const into = signal('in storify');
    sheet.open(Content, { title: 'New task', subtitle: into, data: { text: 'x' } });
    await settle();
    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.querySelector('.tc-sheet__subtitle')?.textContent?.trim()).toBe('in storify');

    into.set('in team-console');
    TestBed.tick();
    expect(dialog.querySelector('.tc-sheet__subtitle')?.textContent?.trim()).toBe('in team-console');
  });

  it('names the dialog by its title alone when it has no subtitle', async () => {
    sheet.open(Content, { title: 'Projects', data: { text: 'x' } });
    await settle();

    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    expect(dialog.querySelector('.tc-sheet__subtitle')).toBeNull();
    const ids = (dialog.getAttribute('aria-labelledby') ?? '').split(' ');
    expect(ids).toHaveLength(1);
  });
});

/** Captures the observers the sheet creates so a test can fire them and see them disconnected (#327). */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets: Element[] = [];
  readonly disconnect = vi.fn();

  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  fire(): void {
    this.callback();
  }
}

describe('Sheet footer stacking (#325, #327)', () => {
  let sheet: Sheet;
  let wrapped: boolean;
  let footWidth: number;
  const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');

  beforeEach(async () => {
    FakeResizeObserver.instances = [];
    wrapped = false;
    footWidth = 200;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // The test DOM has no layout: the primary "wraps" to a second line while `wrapped` is set.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return wrapped && this.classList.contains('ok') ? 40 : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.classList.contains('tc-sheet__foot') ? footWidth : 0;
      },
    });
    await TestBed.configureTestingModule({
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    sheet = TestBed.inject(Sheet);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTop);
    if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
    overlay()?.remove();
  });

  async function openActions(): Promise<{ dialog: HTMLElement; footObserver: FakeResizeObserver }> {
    sheet.open(WithActions, { title: 'Snooze', data: { text: 'until' } });
    await settle();
    TestBed.tick();
    const dialog = overlay().querySelector('tc-sheet-container') as HTMLElement;
    const foot = dialog.querySelector('.tc-sheet__foot');
    const footObserver = FakeResizeObserver.instances.find((observer) =>
      observer.targets.includes(foot as Element),
    );
    if (footObserver === undefined) {
      throw new Error('the dialog footer is not observed');
    }
    return { dialog, footObserver };
  }

  async function refit(observer: FakeResizeObserver): Promise<void> {
    observer.fire();
    TestBed.tick();
    await settle();
    TestBed.tick();
  }

  it('stacks the primary over the secondary when the row wraps, and keeps focus on the same button', async () => {
    const { dialog, footObserver } = await openActions();
    expect(footerButtons(dialog)).toEqual(['Cancel', 'Snooze']);
    (dialog.querySelector('.ok') as HTMLButtonElement).focus();

    wrapped = true;
    await refit(footObserver);

    expect(footerButtons(dialog)).toEqual(['Snooze', 'Cancel']);
    expect(dialog.querySelector('.tc-sheet__foot')?.classList).toContain('tc-sheet__foot--stacked');
    expect(document.activeElement).toBe(dialog.querySelector('.ok'));
  });

  it('does not stack a row that fits', async () => {
    const { dialog, footObserver } = await openActions();

    await refit(footObserver);

    expect(footerButtons(dialog)).toEqual(['Cancel', 'Snooze']);
  });

  it('tries the row again only once the stacked footer is wider than when it stacked', async () => {
    const { dialog, footObserver } = await openActions();
    wrapped = true;
    await refit(footObserver);
    expect(footerButtons(dialog)).toEqual(['Snooze', 'Cancel']);

    wrapped = false;
    await refit(footObserver);
    expect(footerButtons(dialog)).toEqual(['Snooze', 'Cancel']);

    footWidth = 320;
    await refit(footObserver);
    expect(footerButtons(dialog)).toEqual(['Cancel', 'Snooze']);
  });

  it('disconnects the footer observer when the dialog closes', async () => {
    const { footObserver } = await openActions();
    expect(footObserver.disconnect).not.toHaveBeenCalled();

    sheet.closeAll();
    await settle();
    TestBed.tick();

    expect(footObserver.disconnect).toHaveBeenCalled();
  });
});
