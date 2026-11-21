import { Component, ElementRef, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Sheet } from '../sheet/sheet';
import { injectRetryFocus } from './restore-retry-focus';

@Component({
  template: `<h1 #heading tabindex="-1">Title</h1>
    <tc-state-block class="tc-state-block--error"
      ><a tc-state-action href="#setup">Setup</a><button tc-state-action type="button">Retry</button></tc-state-block
    >`,
})
class Host {
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  readonly restore = injectRetryFocus(() => this.heading());
}

describe('injectRetryFocus', () => {
  async function createHost() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [{ provide: Sheet, useValue: { hasOpen: () => false } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  it('focuses the Retry button, not a link, when focus fell back to the body', async () => {
    const fixture = await createHost();
    (document.activeElement as HTMLElement | null)?.blur();

    fixture.componentInstance.restore();
    await fixture.whenStable();

    expect(document.activeElement?.textContent).toBe('Retry');
  });

  it('falls back to the heading when no error block is left', async () => {
    const fixture = await createHost();
    (fixture.nativeElement as HTMLElement).querySelector('tc-state-block')?.remove();

    fixture.componentInstance.restore();
    await fixture.whenStable();

    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('leaves focus alone once the owner has moved it', async () => {
    const fixture = await createHost();
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('a');
    link?.focus();

    fixture.componentInstance.restore();
    await fixture.whenStable();

    expect(document.activeElement).toBe(link);
  });
});
