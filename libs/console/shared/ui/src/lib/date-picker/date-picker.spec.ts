import { BreakpointObserver } from '@angular/cdk/layout';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Field } from '../field/field';
import { DatePicker, type DatePickerProblem } from './date-picker';

const TODAY = '2026-10-08';

@Component({
  imports: [DatePicker, Field, ReactiveFormsModule],
  template: `
    <tc-field label="Дата демо" [error]="problem()?.message ?? ''">
      <tc-date-picker
        [formControl]="control"
        [today]="today"
        [min]="min()"
        [max]="max()"
        [isDateDisabled]="isDateDisabled"
        (problemChange)="problem.set($event)"
      />
    </tc-field>
  `,
})
class Host {
  readonly control = new FormControl<string | null>('2026-10-16');
  readonly today = TODAY;
  readonly min = signal<string | null>(TODAY);
  readonly max = signal<string | null>('2026-11-20');
  readonly problem = signal<DatePickerProblem | null>(null);
  readonly isDateDisabled = (day: string): boolean => day === '2026-10-20';
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function overlay(): HTMLElement {
  return document.querySelector('.cdk-overlay-container') as HTMLElement;
}

/** The grid's tab stop: where the keys go, as focus follows it. */
function focusedCell(): HTMLElement {
  return document.querySelector('.tc-date-panel__day[tabindex="0"]') as HTMLElement;
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
}

describe('DatePicker', () => {
  let isPhone = false;

  beforeEach(async () => {
    isPhone = false;
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideConsoleI18n(),
        { provide: BreakpointObserver, useValue: { isMatched: () => isPhone } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });

  afterEach(() => {
    overlay()?.remove();
  });

  async function render() {
    const fixture = TestBed.createComponent(Host);
    fixture.autoDetectChanges();
    await settle();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('input') as HTMLInputElement;
    const toggle = root.querySelector('.tc-date-picker__toggle') as HTMLButtonElement;
    const type = async (text: string): Promise<void> => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      await settle();
    };
    const panel = (): HTMLElement | null => overlay()?.querySelector('tc-date-picker-panel') ?? null;
    const focusedDay = (): string | null =>
      panel()?.querySelector('.tc-date-panel__day[tabindex="0"]')?.getAttribute('data-day') ?? null;
    return { fixture, host: fixture.componentInstance, root, input, toggle, type, panel, focusedDay };
  }

  describe('as a form control', () => {
    it('shows the value as DD.MM.YYYY in a labelled text input wired to the field', async () => {
      const { root, input, toggle } = await render();
      expect(input.type).toBe('text');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.value).toBe('16.10.2026');
      expect(input.placeholder).toBe('ДД.ММ.ГГГГ');
      expect(root.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('Дата демо');
      expect(toggle.getAttribute('aria-haspopup')).toBe('dialog');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe('Изменить дату, выбрано 16.10.2026');
    });

    it('writes the form value into the field and reports typed days as ISO on blur only', async () => {
      const { host, input, type } = await render();
      host.control.setValue('2026-11-02');
      await settle();
      expect(input.value).toBe('02.11.2026');

      input.value = '17.10.2026';
      input.dispatchEvent(new Event('input'));
      await settle();
      expect(host.control.value).toBe('2026-11-02');

      input.dispatchEvent(new Event('blur'));
      await settle();
      expect(host.control.value).toBe('2026-10-17');
      expect(host.control.touched).toBe(true);
      expect(input.value).toBe('17.10.2026');

      await type('2026-10-18');
      expect(host.control.value).toBe('2026-10-18');
      expect(input.value).toBe('18.10.2026');
    });

    it('reads typed text on Enter too', async () => {
      const { host, input } = await render();
      input.value = '21/10/2026';
      input.dispatchEvent(new Event('input'));
      key(input, 'Enter');
      await settle();
      expect(host.control.value).toBe('2026-10-21');
    });

    it('keeps text that is not a date as typed, empties the value and says how to type it', async () => {
      const { host, root, input, type } = await render();
      await type('31.02.2026');
      expect(input.value).toBe('31.02.2026');
      expect(host.control.value).toBeNull();
      expect(host.control.errors).toEqual({ datePicker: { kind: 'invalid' } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      const error = root.querySelector('.tc-field__error') as HTMLElement;
      expect(error.textContent).toBe('Такой даты нет. Введите её как ДД.ММ.ГГГГ, например 08.10.2026.');
      expect(input.getAttribute('aria-describedby')).toBe(error.id);

      await type('16.10.2026');
      expect(host.control.value).toBe('2026-10-16');
      expect(host.control.errors).toBeNull();
      expect(input.getAttribute('aria-invalid')).toBeNull();
    });

    it('keeps a day outside min/max or a disabled one as the value, with the reason as an error', async () => {
      const { host, type } = await render();
      await type('07.10.2026');
      expect(host.control.value).toBe('2026-10-07');
      expect(host.control.errors).toEqual({ datePicker: { kind: 'min' } });
      expect(host.problem()?.message).toBe('Выберите 08.10.2026 или позже.');

      await type('21.11.2026');
      expect(host.problem()?.message).toBe('Выберите 20.11.2026 или раньше.');

      await type('20.10.2026');
      expect(host.control.errors).toEqual({ datePicker: { kind: 'unavailable' } });
    });

    it('clears the value when the text is erased', async () => {
      const { host, type } = await render();
      await type('');
      expect(host.control.value).toBeNull();
      expect(host.control.errors).toBeNull();
    });

    it('follows the form when it is disabled', async () => {
      const { host, input, toggle } = await render();
      host.control.disable();
      await settle();
      expect(input.disabled).toBe(true);
      expect(toggle.disabled).toBe(true);
    });
  });

  describe('the calendar popover', () => {
    it('opens on the selected day as a modal dialog named by the month, Monday first', async () => {
      const { toggle, panel, focusedDay } = await render();
      toggle.click();
      await settle();
      const dialog = panel() as HTMLElement;
      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      const heading = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
      expect(heading?.textContent?.trim()).toBe('Октябрь 2026');
      expect(heading?.getAttribute('aria-live')).toBe('polite');
      expect(Array.from(dialog.querySelectorAll('th')).map((th) => th.textContent?.trim())).toEqual([
        'Пн',
        'Вт',
        'Ср',
        'Чт',
        'Пт',
        'Сб',
        'Вс',
      ]);
      expect(dialog.querySelector('th')?.getAttribute('abbr')).toBe('понедельник');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(focusedDay()).toBe('2026-10-16');
      expect(document.activeElement?.getAttribute('data-day')).toBe('2026-10-16');
      // One tab stop in the grid.
      expect(dialog.querySelectorAll('.tc-date-panel__day[tabindex="0"]')).toHaveLength(1);
    });

    it('marks today, the selected day and the days that cannot be picked', async () => {
      const { toggle, panel } = await render();
      toggle.click();
      await settle();
      const cell = (day: string) => panel()?.querySelector(`[data-day="${day}"]`) as HTMLElement;
      expect(cell(TODAY).getAttribute('aria-current')).toBe('date');
      expect(cell(TODAY).getAttribute('aria-label')).toBe('четверг, 8 октября 2026 г., сегодня');
      expect(cell('2026-10-16').getAttribute('aria-selected')).toBe('true');
      expect(cell('2026-10-07').getAttribute('aria-disabled')).toBe('true');
      expect(cell('2026-10-07').getAttribute('aria-label')).toBe('среда, 7 октября 2026 г., недоступно');
      expect(cell('2026-10-20').getAttribute('aria-disabled')).toBe('true');
      // The whole of September is before min.
      expect((panel()?.querySelector('.tc-date-panel__prev') as HTMLButtonElement).disabled).toBe(true);
      expect((panel()?.querySelector('.tc-date-panel__next') as HTMLButtonElement).disabled).toBe(false);
    });

    it('moves focus with the APG keys and commits on Enter, returning focus to the button', async () => {
      const { host, input, toggle, panel, focusedDay } = await render();
      toggle.click();
      await settle();
      key(focusedCell(), 'ArrowRight');
      await settle();
      expect(focusedDay()).toBe('2026-10-17');
      expect(document.activeElement?.getAttribute('data-day')).toBe('2026-10-17');
      key(focusedCell(), 'ArrowDown');
      key(focusedCell(), 'Home');
      await settle();
      expect(focusedDay()).toBe('2026-10-19');
      key(focusedCell(), 'PageDown');
      await settle();
      expect(focusedDay()).toBe('2026-11-19');
      expect(panel()?.querySelector('.tc-date-panel__month')?.textContent?.trim()).toBe('Ноябрь 2026');
      // Past max: clamped.
      key(focusedCell(), 'PageDown');
      await settle();
      expect(focusedDay()).toBe('2026-11-20');
      key(focusedCell(), 'Enter');
      await settle();
      expect(host.control.value).toBe('2026-11-20');
      expect(input.value).toBe('20.11.2026');
      expect(panel()).toBeNull();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
    });

    it('does not select a day that cannot be picked', async () => {
      const { host, toggle, panel, focusedDay } = await render();
      toggle.click();
      await settle();
      // 16 → 20 October, the disabled day: reachable, not selectable.
      for (let step = 0; step < 4; step += 1) {
        key(focusedCell(), 'ArrowRight');
      }
      await settle();
      expect(focusedDay()).toBe('2026-10-20');
      key(focusedCell(), 'Enter');
      await settle();
      expect(panel()).not.toBeNull();
      expect(host.control.value).toBe('2026-10-16');
    });

    it('Escape closes without a change and returns focus to the button', async () => {
      const { host, toggle, panel } = await render();
      toggle.click();
      await settle();
      key(focusedCell(), 'ArrowRight');
      key(focusedCell(), ' ');
      await settle();
      expect(panel()?.querySelector('[aria-selected="true"]')?.getAttribute('data-day')).toBe('2026-10-17');
      key(focusedCell(), 'Escape');
      await settle();
      expect(panel()).toBeNull();
      expect(host.control.value).toBe('2026-10-16');
      expect(document.activeElement).toBe(toggle);
    });

    it('Today selects today without closing; Done commits the selection', async () => {
      const { host, toggle, panel } = await render();
      toggle.click();
      await settle();
      const foot = Array.from(panel()?.querySelectorAll('.tc-date-panel__foot button') ?? []);
      expect(foot.map((button) => button.textContent?.trim())).toEqual(['Сегодня', 'Готово']);
      (foot[0] as HTMLButtonElement).click();
      await settle();
      expect(panel()?.querySelector('[aria-selected="true"]')?.getAttribute('data-day')).toBe(TODAY);
      expect(host.control.value).toBe('2026-10-16');
      (foot[1] as HTMLButtonElement).click();
      await settle();
      expect(panel()).toBeNull();
      expect(host.control.value).toBe(TODAY);
    });

    it('a click selects a day and Done commits it; the month buttons change the month', async () => {
      const { host, toggle, panel } = await render();
      toggle.click();
      await settle();
      (panel()?.querySelector('.tc-date-panel__next') as HTMLButtonElement).click();
      await settle();
      expect(panel()?.querySelector('.tc-date-panel__month')?.textContent?.trim()).toBe('Ноябрь 2026');
      (panel()?.querySelector('[data-day="2026-11-03"]') as HTMLElement).click();
      (panel()?.querySelector('.tc-date-panel__done') as HTMLButtonElement).click();
      await settle();
      expect(host.control.value).toBe('2026-11-03');
    });

    it('Alt+ArrowDown in the input opens it; an empty field starts on today', async () => {
      const { host, input, focusedDay } = await render();
      host.control.setValue(null);
      await settle();
      key(input, 'ArrowDown', { altKey: true });
      await settle();
      expect(focusedDay()).toBe(TODAY);
    });

    it('starts on the first day that can be picked when today cannot', async () => {
      const { host, toggle, focusedDay } = await render();
      host.control.setValue(null);
      host.min.set('2026-10-19');
      await settle();
      toggle.click();
      await settle();
      // 19 October is min, 20 October is disabled: the 19th.
      expect(focusedDay()).toBe('2026-10-19');
    });
  });

  describe('on the phone', () => {
    it('opens the calendar in a sheet titled by the field, with the actions in its footer, Done first', async () => {
      isPhone = true;
      const { host, toggle } = await render();
      toggle.click();
      await settle();
      const sheet = overlay().querySelector('tc-sheet-container') as HTMLElement;
      expect(sheet.getAttribute('role')).toBe('dialog');
      expect(sheet.querySelector('.tc-sheet__title')?.textContent?.trim()).toBe('Дата демо');
      const panel = sheet.querySelector('tc-date-picker-panel') as HTMLElement;
      expect(panel.getAttribute('role')).toBeNull();
      const foot = Array.from(sheet.querySelectorAll('.tc-sheet__foot button')).map((b) =>
        b.textContent?.trim(),
      );
      expect(foot).toEqual(['Готово', 'Сегодня']);
      (panel.querySelector('[data-day="2026-10-22"]') as HTMLElement).click();
      (sheet.querySelector('.tc-date-panel__done') as HTMLButtonElement).click();
      await settle();
      await settle();
      expect(host.control.value).toBe('2026-10-22');
    });
  });
});
