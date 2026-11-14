import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Choice, ChoiceGroup } from './choice';

@Component({
  imports: [Choice, ChoiceGroup],
  template: `
    <fieldset tc-choice-group legend="For how long">
      <label tc-choice><input type="radio" name="when" value="hour" checked /> For an hour</label>
      <label tc-choice><input type="radio" name="when" value="week" /> For a week</label>
    </fieldset>
    <label tc-choice>
      <input type="checkbox" aria-describedby="hint" />
      Still send urgent ones
      <small tc-choice-hint id="hint">The team paused itself.</small>
    </label>
  `,
})
class Host {}

describe('Choice', () => {
  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('names the radio group by its legend and keeps native radios', async () => {
    const root = await render();
    const group = root.querySelector('fieldset.tc-choice-group');
    expect(group?.querySelector('legend')?.textContent?.trim()).toBe('For how long');
    const radios = [...(group?.querySelectorAll<HTMLInputElement>('input[type=radio]') ?? [])];
    expect(radios.map((radio) => radio.value)).toEqual(['hour', 'week']);
  });

  it('makes the whole row the label of its control, hint included', async () => {
    const root = await render();
    const rows = [...root.querySelectorAll<HTMLLabelElement>('label.tc-choice')];
    expect(rows).toHaveLength(3);
    const checkbox = rows[2]?.control;
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    expect(rows[2]?.querySelector('.tc-choice__text [tc-choice-hint]')?.id).toBe('hint');

    rows[1]?.click();
    expect((rows[1]?.control as HTMLInputElement).checked).toBe(true);
    expect((rows[0]?.control as HTMLInputElement).checked).toBe(false);
  });
});

@Component({
  imports: [Choice, ChoiceGroup],
  template: `
    <fieldset tc-choice-group legend="Which sprint">
      <label tc-choice [off]="isOff()">
        <input type="radio" name="sprint" value="current" aria-describedby="why" />
        Current
        <small tc-choice-hint id="why">Frozen until the demo.</small>
      </label>
      <label tc-choice><input type="radio" name="sprint" value="next" checked /> Next</label>
    </fieldset>
  `,
})
class OffHost {
  readonly isOff = signal(true);
}

describe('Choice off with a reason (#107)', () => {
  async function render(): Promise<{ root: HTMLElement; host: OffHost; stabilise: () => Promise<void> }> {
    const fixture = TestBed.createComponent(OffHost);
    await fixture.whenStable();
    return {
      root: fixture.nativeElement as HTMLElement,
      host: fixture.componentInstance,
      stabilise: () => fixture.whenStable(),
    };
  }

  it('keeps the input focusable and enabled but marks it aria-disabled, with its reason', async () => {
    const { root } = await render();
    const current = root.querySelector<HTMLInputElement>('input[value=current]');
    expect(current?.disabled).toBe(false);
    expect(current?.getAttribute('aria-disabled')).toBe('true');
    expect(current?.getAttribute('aria-describedby')).toBe('why');
    expect(root.querySelector('label.tc-choice')?.classList).toContain('tc-choice--off');
  });

  it('never checks an off option, from the row or the radio itself; the old choice stays', async () => {
    const { root } = await render();
    const row = root.querySelector<HTMLLabelElement>('label.tc-choice');
    const current = root.querySelector<HTMLInputElement>('input[value=current]');
    const next = root.querySelector<HTMLInputElement>('input[value=next]');

    row?.click();
    current?.click();

    expect(current?.checked).toBe(false);
    expect(next?.checked).toBe(true);
  });

  it('becomes a normal option again once it is no longer off', async () => {
    const { root, host, stabilise } = await render();
    host.isOff.set(false);
    await stabilise();
    const current = root.querySelector<HTMLInputElement>('input[value=current]');
    expect(current?.hasAttribute('aria-disabled')).toBe(false);

    current?.click();
    expect(current?.checked).toBe(true);
  });
});
