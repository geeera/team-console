import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StatusCard, type StatusCardTone } from './status-card';

@Component({
  imports: [StatusCard],
  template: `
    <section tc-status-card [tone]="tone()" [loading]="loading()" loadingLabel="Checking notifications…">
      <h3 tc-status-card-title>Notifications are on</h3>
      <p tc-status-card-body>Since 2 October</p>
    </section>
  `,
})
class Host {
  readonly tone = signal<StatusCardTone>('neutral');
  readonly loading = signal(false);
}

describe('StatusCard', () => {
  async function render(): Promise<{ host: Host; card: HTMLElement; flush: () => Promise<void> }> {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return {
      host: fixture.componentInstance,
      card: (fixture.nativeElement as HTMLElement).querySelector('section') as HTMLElement,
      flush: () => fixture.whenStable(),
    };
  }

  it('keeps the caller’s element and heading and marks the tone with a class only', async () => {
    const { host, card, flush } = await render();

    expect(card.classList).toContain('tc-status-card');
    expect(card.querySelector('h3')?.textContent).toBe('Notifications are on');
    expect(card.className).not.toMatch(/tc-status-card--(success|warning|danger)/);

    host.tone.set('warning');
    await flush();
    expect(card.classList).toContain('tc-status-card--warning');
  });

  it('shows a skeleton with a screen-reader label instead of the content while loading', async () => {
    const { host, card, flush } = await render();
    host.loading.set(true);
    await flush();

    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(card.querySelector('h3')).toBeNull();
    expect(card.querySelector('.tc-sr-only')?.textContent).toBe('Checking notifications…');
    expect(card.querySelector('.tc-status-card__skeleton')?.getAttribute('aria-hidden')).toBe('true');

    host.loading.set(false);
    await flush();
    expect(card.getAttribute('aria-busy')).toBeNull();
    expect(card.querySelector('h3')).not.toBeNull();
  });
});
