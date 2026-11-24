import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Roll } from './roll';

@Component({ imports: [Roll], template: `<tc-roll [value]="value()" />` })
class Host {
  readonly value = signal<string | number>(3);
}

describe('Roll', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const roll = (): HTMLElement => fixture.nativeElement.querySelector('tc-roll');
    const outgoing = (): HTMLElement | null => roll().querySelector('.tc-roll__out');
    const incoming = (): HTMLElement => roll().querySelector('.tc-roll__in') as HTMLElement;
    const change = async (value: string | number): Promise<void> => {
      fixture.componentInstance.value.set(value);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const endMotion = (): void => {
      incoming().dispatchEvent(new Event('animationend'));
      fixture.detectChanges();
    };
    return { roll, outgoing, incoming, change, endMotion };
  }

  it('shows the first value still, with nothing leaving', () => {
    const { roll, outgoing, incoming } = setup();
    expect(roll().textContent?.trim()).toBe('3');
    expect(outgoing()).toBeNull();
    expect(incoming().classList.contains('tc-roll__in--rolling')).toBe(false);
  });

  it('rolls the old value out and the new one in when the value changes', async () => {
    const { outgoing, incoming, change } = setup();
    await change(2);
    expect(outgoing()?.textContent?.trim()).toBe('3');
    expect(incoming().textContent?.trim()).toBe('2');
    expect(incoming().classList.contains('tc-roll__in--rolling')).toBe(true);
  });

  it('hides the leaving value from assistive tech', async () => {
    const { outgoing, change } = setup();
    await change(2);
    expect(outgoing()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('drops the leaving value once the motion ends', async () => {
    const { outgoing, incoming, change, endMotion } = setup();
    await change(2);
    endMotion();
    expect(outgoing()).toBeNull();
    expect(incoming().classList.contains('tc-roll__in--rolling')).toBe(false);
  });

  it('does not roll when the value is set to the same text', async () => {
    const { outgoing, change } = setup();
    await change('3');
    expect(outgoing()).toBeNull();
  });

  it('restarts the motion when the value changes mid-roll', async () => {
    const { outgoing, incoming, change } = setup();
    await change(2);
    const first = incoming();
    await change(1);
    expect(incoming()).not.toBe(first);
    expect(outgoing()?.textContent?.trim()).toBe('2');
  });
});
