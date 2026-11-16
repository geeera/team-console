import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Segment, SegmentedRadio } from './segmented';

@Component({
  imports: [Segment, SegmentedRadio],
  template: `
    <fieldset tc-segmented legend="Kind">
      <label tc-segment
        ><input type="radio" name="kind" value="feature" checked aria-describedby="h" /> Feature</label
      >
      <label tc-segment><input type="radio" name="kind" value="bug" aria-describedby="h" /> Bug</label>
      <label tc-segment><input type="radio" name="kind" value="chore" aria-describedby="h" /> Chore</label>
      <p tc-segmented-hint id="h">Something new.</p>
    </fieldset>
  `,
})
class Host {}

@Component({
  imports: [Segment, SegmentedRadio],
  template: `
    <fieldset tc-segmented legend="Kind">
      <label tc-segment><input type="radio" name="kind-disabled" value="feature" checked /> Feature</label>
      <label tc-segment><input type="radio" name="kind-disabled" value="bug" disabled /> Bug</label>
    </fieldset>
  `,
})
class DisabledHost {}

describe('SegmentedRadio', () => {
  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('is a native radio group named by its legend, with the hint after the segments', async () => {
    const root = await render();
    const group = root.querySelector('fieldset.tc-segmented');
    expect(group?.querySelector('legend')?.textContent?.trim()).toBe('Kind');
    const radios = [
      ...(group?.querySelectorAll<HTMLInputElement>('.tc-segmented__options input[type=radio]') ?? []),
    ];
    expect(radios.map((radio) => radio.value)).toEqual(['feature', 'bug', 'chore']);
    expect(group?.lastElementChild?.id).toBe('h');
  });

  it('makes the whole segment the label of its radio, so a tap chooses it', async () => {
    const root = await render();
    const segments = [...root.querySelectorAll<HTMLLabelElement>('label.tc-segment')];
    expect(segments.map((segment) => segment.textContent?.trim())).toEqual(['Feature', 'Bug', 'Chore']);

    segments[1]?.click();
    expect((segments[1]?.control as HTMLInputElement).checked).toBe(true);
    expect((segments[0]?.control as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a disabled segment unchosen when its label is clicked', async () => {
    const fixture = TestBed.createComponent(DisabledHost);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const segments = [...root.querySelectorAll<HTMLLabelElement>('label.tc-segment')];
    const disabled = segments[1]?.control as HTMLInputElement;
    expect(disabled.disabled).toBe(true);

    segments[1]?.click();
    expect(disabled.checked).toBe(false);
    expect((segments[0]?.control as HTMLInputElement).checked).toBe(true);
  });
});
