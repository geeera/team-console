import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveDot, type LiveDotDepth, type LiveDotTone } from './live-dot';

@Component({
  imports: [LiveDot],
  template: '<tc-live-dot [tone]="tone()" [depth]="depth()" [paused]="paused()" />',
})
class Host {
  readonly tone = signal<LiveDotTone>('accent');
  readonly depth = signal<LiveDotDepth>('soft');
  readonly paused = signal(false);
}

describe('LiveDot', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const dot = (): HTMLElement => fixture.nativeElement.querySelector('tc-live-dot');
    return { fixture, dot };
  }

  it('is decorative: hidden from assistive tech', () => {
    expect(setup().dot().getAttribute('aria-hidden')).toBe('true');
  });

  it('defaults to the accent tone, soft depth and running', () => {
    const { dot } = setup();
    expect(dot().classList.contains('tc-live-dot--success')).toBe(false);
    expect(dot().classList.contains('tc-live-dot--deep')).toBe(false);
    expect(dot().classList.contains('tc-live-dot--paused')).toBe(false);
  });

  it('follows tone, depth and paused', () => {
    const { fixture, dot } = setup();
    fixture.componentInstance.tone.set('success');
    fixture.componentInstance.depth.set('deep');
    fixture.componentInstance.paused.set(true);
    fixture.detectChanges();
    expect(dot().classList.contains('tc-live-dot--success')).toBe(true);
    expect(dot().classList.contains('tc-live-dot--deep')).toBe(true);
    expect(dot().classList.contains('tc-live-dot--paused')).toBe(true);
  });
});
