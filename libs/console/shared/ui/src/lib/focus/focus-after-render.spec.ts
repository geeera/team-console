import { Component, ElementRef, Injector, inject, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Sheet } from '../sheet/sheet';
import { focusAfterRender } from './focus-after-render';

@Component({
  template: `<h1 #heading tabindex="-1">Title</h1>`,
})
class Host {
  readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  focus(): void {
    focusAfterRender(() => this.heading(), { injector: this.injector });
  }
}

describe('focusAfterRender', () => {
  function sheetStub(hasOpen: boolean): Pick<Sheet, 'hasOpen'> {
    return { hasOpen: () => hasOpen };
  }

  async function createHost(hasOpen: boolean): Promise<ReturnType<typeof TestBed.createComponent<Host>>> {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [{ provide: Sheet, useValue: sheetStub(hasOpen) }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  it('focuses the target when no sheet or dialog is open', async () => {
    const fixture = await createHost(false);
    fixture.componentInstance.focus();
    await fixture.whenStable();

    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('skips the move while a sheet or dialog is open', async () => {
    const fixture = await createHost(true);
    fixture.componentInstance.focus();
    await fixture.whenStable();

    expect(document.activeElement?.tagName).not.toBe('H1');
  });
});
