import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Banner, type BannerTone } from './banner';

@Component({
  imports: [Banner],
  template: `<div tc-banner [tone]="tone()">
    <p tc-banner-text>Paused</p>
    <div tc-banner-actions><button>Resume</button></div>
  </div>`,
})
class Host {
  readonly tone = signal<BannerTone>('warning');
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
});
