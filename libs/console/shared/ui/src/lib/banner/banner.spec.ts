import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Banner, type BannerTone } from './banner';

@Component({
  imports: [Banner],
  template: `<div tc-banner [tone]="tone()" [note]="note()">
    <p tc-banner-text>Paused</p>
    <div tc-banner-actions><button>Resume</button></div>
  </div>`,
})
class Host {
  readonly tone = signal<BannerTone>('warning');
  readonly note = signal(false);
}

describe('Banner', () => {
  it('projects text and actions and follows the tone', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const banner = fixture.nativeElement.querySelector('.tc-banner') as HTMLElement;
    expect(banner.classList).toContain('tc-banner--warning');
    expect(banner.querySelector('[tc-banner-text]')?.textContent).toBe('Paused');
    expect(banner.querySelector('[tc-banner-actions] button')).not.toBeNull();

    fixture.componentInstance.tone.set('danger');
    await fixture.whenStable();
    expect(banner.classList).toContain('tc-banner--danger');
    expect(banner.classList).not.toContain('tc-banner--warning');
  });

  it('a note carries a decorative paperclip and a plain strip does not (#357)', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const banner = fixture.nativeElement.querySelector('.tc-banner') as HTMLElement;
    expect(banner.classList).not.toContain('tc-banner--note');
    expect(banner.querySelector('.tc-banner__clip')).toBeNull();

    fixture.componentInstance.note.set(true);
    await fixture.whenStable();
    expect(banner.classList).toContain('tc-banner--note');
    expect(banner.querySelector('.tc-banner__clip')?.getAttribute('aria-hidden')).toBe('true');
  });
});
