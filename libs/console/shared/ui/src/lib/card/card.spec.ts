import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Card, CardStamp } from './card';

@Component({
  imports: [Card],
  template: `
    <tc-card [stamp]="stamp()" [seal]="seal()">
      <span tc-card-kind>Question</span>
      <h3 tc-card-title>Ship it?</h3>
      <p>Body</p>
    </tc-card>
  `,
})
class Host {
  readonly stamp = signal<CardStamp | null>(null);
  readonly seal = signal<string | null>(null);
}

describe('Card', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const card = (fixture.nativeElement as HTMLElement).querySelector('tc-card') as HTMLElement;
    return { fixture, card };
  }

  it('projects kind, title and body', async () => {
    const { card } = await render();

    expect(card.querySelector('.tc-card__kind')?.textContent?.trim()).toBe('Question');
    expect(card.querySelector('h3')?.textContent?.trim()).toBe('Ship it?');
    expect(card.querySelector('.tc-card__body')?.textContent?.trim()).toBe('Body');
    expect(card.querySelector('.tc-card__stamp')).toBeNull();
  });

  it('presses a decorative stamp with the glyph of the answer', async () => {
    const { fixture, card } = await render();

    fixture.componentInstance.stamp.set('negative');
    await fixture.whenStable();

    const stamp = card.querySelector('.tc-card__stamp') as HTMLElement;
    expect(stamp.getAttribute('aria-hidden')).toBe('true');
    expect(card.classList.contains('tc-card--negative')).toBe(true);
    expect(stamp.querySelector('tc-icon path')?.getAttribute('d')).toBe('M6 6l12 12M18 6L6 18');
  });

  it('presses a large seal with words instead of the glyph, and only on a stamped card (#361)', async () => {
    const { fixture, card } = await render();

    fixture.componentInstance.seal.set('Release · 16.10');
    await fixture.whenStable();
    expect(card.querySelector('.tc-card__stamp')).toBeNull();
    expect(card.classList.contains('tc-card--sealed')).toBe(false);

    fixture.componentInstance.stamp.set('positive');
    await fixture.whenStable();
    const stamp = card.querySelector('.tc-card__stamp') as HTMLElement;
    expect(stamp.classList.contains('tc-card__stamp--seal')).toBe(true);
    expect(stamp.getAttribute('aria-hidden')).toBe('true');
    expect(stamp.querySelector('.tc-card__seal-text')?.textContent).toBe('Release · 16.10');
    expect(stamp.querySelector('tc-icon')).toBeNull();
    expect(card.classList.contains('tc-card--sealed')).toBe(true);
  });
});
