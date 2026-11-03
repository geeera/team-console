import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Meter, meterPercent } from './meter';

describe('meterPercent', () => {
  it('is the whole percentage of value over max', () => {
    expect(meterPercent(2, 3)).toBe(67);
    expect(meterPercent(0, 5)).toBe(0);
    expect(meterPercent(5, 5)).toBe(100);
  });

  it('clamps to 0…100 and reads an empty or invalid max as 0', () => {
    expect(meterPercent(7, 5)).toBe(100);
    expect(meterPercent(-1, 5)).toBe(0);
    expect(meterPercent(3, 0)).toBe(0);
    expect(meterPercent(Number.NaN, 5)).toBe(0);
    expect(meterPercent(1, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

@Component({
  imports: [Meter],
  template: '<tc-meter [value]="value()" [max]="max()" />',
})
class Host {
  readonly value = signal(1);
  readonly max = signal(4);
}

describe('Meter', () => {
  it('is decorative and fills to the ratio', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const meter = (fixture.nativeElement as HTMLElement).querySelector('tc-meter');
    const fill = meter?.querySelector<HTMLElement>('.tc-meter__fill');

    expect(meter?.getAttribute('aria-hidden')).toBe('true');
    expect(fill?.style.inlineSize).toBe('25%');

    fixture.componentInstance.value.set(3);
    await fixture.whenStable();
    expect(fill?.style.inlineSize).toBe('75%');
  });
});
