import { Component } from '@angular/core';
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
