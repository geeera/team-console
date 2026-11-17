import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { Switch } from './switch';

@Component({
  imports: [Switch, ReactiveFormsModule],
  template: `
    <button tc-switch type="button" aria-label="UI designer" [formControl]="control"></button>
    <button
      tc-switch
      type="button"
      aria-label="Bug triage"
      [off]="off()"
      aria-describedby="story-off-why"
      [formControl]="offControl"
    ></button>
    <p id="story-off-why">Needs the Pro plan.</p>
    <button
      tc-switch
      type="button"
      aria-label="Security"
      locked
      aria-describedby="story-locked-why"
      [formControl]="lockedControl"
    ></button>
    <p id="story-locked-why">Always on: needed to check access.</p>
  `,
})
class Host {
  readonly control = new FormControl(false, { nonNullable: true });
  readonly off = signal(false);
  readonly offControl = new FormControl(false, { nonNullable: true });
  readonly lockedControl = new FormControl(true, { nonNullable: true });
}

@Component({
  imports: [Switch, FormsModule],
  template: `<button tc-switch type="button" aria-label="Standalone" [ngModel]="checked()" (ngModelChange)="checked.set($event)"></button>`,
})
class StandaloneHost {
  readonly checked = signal(false);
}

describe('Switch', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const buttons = fixture.nativeElement.querySelectorAll('button[tc-switch]') as NodeListOf<HTMLButtonElement>;
    return {
      fixture,
      host: fixture.componentInstance,
      switchEl: buttons[0] as HTMLButtonElement,
      offEl: buttons[1] as HTMLButtonElement,
      lockedEl: buttons[2] as HTMLButtonElement,
    };
  }

  it('is a native button with role switch, reflecting the form value as aria-checked', async () => {
    const { switchEl } = await render();
    expect(switchEl.tagName).toBe('BUTTON');
    expect(switchEl.getAttribute('role')).toBe('switch');
    expect(switchEl.getAttribute('type')).toBe('button');
    expect(switchEl.getAttribute('aria-checked')).toBe('false');
    expect(switchEl.hasAttribute('aria-disabled')).toBe(false);
  });

  it('toggles on click and writes the new value back to the form control', async () => {
    const { fixture, host, switchEl } = await render();
    switchEl.click();
    await fixture.whenStable();
    expect(switchEl.getAttribute('aria-checked')).toBe('true');
    expect(host.control.value).toBe(true);
    expect(host.control.touched).toBe(true);

    switchEl.click();
    await fixture.whenStable();
    expect(switchEl.getAttribute('aria-checked')).toBe('false');
    expect(host.control.value).toBe(false);
  });

  it('follows the form control when it is set from outside', async () => {
    const { fixture, host, switchEl } = await render();
    host.control.setValue(true);
    await fixture.whenStable();
    expect(switchEl.getAttribute('aria-checked')).toBe('true');
  });

  it('follows the form when it is disabled, as a native disabled control', async () => {
    const { fixture, host, switchEl } = await render();
    host.control.disable();
    await fixture.whenStable();
    expect(switchEl.disabled).toBe(true);
  });

  it('off: stays focusable with aria-disabled, keeps the reason linked, and ignores a click', async () => {
    const { fixture, host, offEl } = await render();
    expect(offEl.hasAttribute('disabled')).toBe(false);
    expect(offEl.getAttribute('aria-disabled')).toBeNull();
    expect(offEl.getAttribute('aria-describedby')).toBe('story-off-why');

    host.off.set(true);
    await fixture.whenStable();
    expect(offEl.getAttribute('aria-disabled')).toBe('true');

    offEl.click();
    await fixture.whenStable();
    expect(offEl.getAttribute('aria-checked')).toBe('false');
    expect(host.offControl.value).toBe(false);
  });

  it('locked: reads aria-checked true, is aria-disabled, keeps the reason linked, and never toggles', async () => {
    const { fixture, host, lockedEl } = await render();
    expect(lockedEl.getAttribute('aria-checked')).toBe('true');
    expect(lockedEl.getAttribute('aria-disabled')).toBe('true');
    expect(lockedEl.getAttribute('aria-describedby')).toBe('story-locked-why');
    expect(lockedEl.querySelector('.tc-switch__lock')).not.toBeNull();

    lockedEl.click();
    await fixture.whenStable();
    expect(lockedEl.getAttribute('aria-checked')).toBe('true');
    expect(host.lockedControl.value).toBe(true);
  });

  it('reads aria-checked true even if a locked switch is bound to false (the lock never lies)', async () => {
    const { fixture, host, lockedEl } = await render();
    host.lockedControl.setValue(false);
    await fixture.whenStable();
    expect(lockedEl.getAttribute('aria-checked')).toBe('true');
  });

  it('works standalone with plain ngModel, no reactive form around it', async () => {
    await TestBed.configureTestingModule({ imports: [StandaloneHost] }).compileComponents();
    const fixture = TestBed.createComponent(StandaloneHost);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button[tc-switch]') as HTMLButtonElement;
    expect(button.getAttribute('aria-checked')).toBe('false');

    button.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.checked()).toBe(true);
    expect(button.getAttribute('aria-checked')).toBe('true');
  });
});
