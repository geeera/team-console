import { Component, ElementRef, Injector, inject, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Sheet } from '../sheet/sheet';
import { focusAfterRender } from './focus-after-render';

@Component({
  template: `<h1 #heading tabindex="-1">Title</h1>
    <button #other type="button">Other</button>`,
})
class Host {
  readonly injector = inject(Injector);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  focus(onlyIfFocusLost = false): void {
    focusAfterRender(() => this.heading(), { injector: this.injector, onlyIfFocusLost });
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

  it('with onlyIfFocusLost, moves focus when it fell back to the body', async () => {
    const fixture = await createHost(false);
    (document.activeElement as HTMLElement | null)?.blur();
    fixture.componentInstance.focus(true);
    await fixture.whenStable();

    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('with onlyIfFocusLost, leaves focus alone when it is already on a control', async () => {
    const fixture = await createHost(false);
    const other = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    other.focus();
    fixture.componentInstance.focus(true);
    await fixture.whenStable();

    expect(document.activeElement).toBe(other);
  });
});
