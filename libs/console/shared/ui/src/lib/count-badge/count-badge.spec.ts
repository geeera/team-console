import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CountBadge } from './count-badge';

@Component({
  imports: [CountBadge],
  template: `<tc-count-badge [count]="count()" [text]="'' + count()" [label]="'Waiting: ' + count()" />`,
})
class Host {
  readonly count = signal(2);
}

describe('CountBadge', () => {
  function setup(start: number) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.count.set(start);
    fixture.detectChanges();
    const host = (): HTMLElement => fixture.nativeElement.querySelector('tc-count-badge');
    const pill = (): HTMLElement | null => host().querySelector('tc-chip');
    const change = async (count: number): Promise<void> => {
      fixture.componentInstance.count.set(count);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const endExit = (): void => {
      pill()?.dispatchEvent(new Event('animationend'));
      fixture.detectChanges();
    };
    return { fixture, host, pill, change, endExit };
  }

  it('shows the count visibly and its full name to assistive tech only', () => {
    const { pill } = setup(2);
    expect(pill()?.querySelector('tc-roll')?.getAttribute('aria-hidden')).toBe('true');
    expect(pill()?.querySelector('tc-roll')?.textContent?.trim()).toBe('2');
    expect(pill()?.querySelector('.tc-sr-only')?.textContent).toBe('Waiting: 2');
    expect(pill()?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('renders nothing and hides its host when it starts at zero', () => {
    const { host, pill } = setup(0);
    expect(pill()).toBeNull();
    expect(host().hidden).toBe(true);
  });

  it('rolls the number when the count changes', async () => {
    const { pill, change } = setup(3);
    await change(2);
    expect(pill()?.querySelector('.tc-roll__out')?.textContent?.trim()).toBe('3');
    expect(pill()?.querySelector('.tc-roll__in')?.textContent?.trim()).toBe('2');
  });

  it('shrinks out at zero: still in the DOM and hidden from assistive tech until the exit ends', async () => {
    const { host, pill, change, endExit } = setup(1);
    await change(0);
    expect(pill()?.classList.contains('tc-count-badge__pill--leaving')).toBe(true);
    expect(pill()?.getAttribute('aria-hidden')).toBe('true');
    expect(host().hidden).toBe(false);

    endExit();
    expect(pill()).toBeNull();
    expect(host().hidden).toBe(true);
  });

  it("is not removed by the number's own roll ending", async () => {
    const { pill, change, fixture } = setup(1);
    await change(0);
    pill()
      ?.querySelector('.tc-roll__in')
      ?.dispatchEvent(new Event('animationend', { bubbles: true }));
    fixture.detectChanges();
    expect(pill()).not.toBeNull();
  });

  it('comes back when a count arrives after the exit, and when it returns mid-exit', async () => {
    const { host, pill, change, endExit } = setup(1);
    await change(0);
    await change(2);
    expect(pill()?.classList.contains('tc-count-badge__pill--leaving')).toBe(false);

    await change(0);
    endExit();
    expect(host().hidden).toBe(true);
    await change(4);
    expect(host().hidden).toBe(false);
    expect(pill()?.querySelector('.tc-sr-only')?.textContent).toBe('Waiting: 4');
  });
});
