import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TopBarAction, TopBarActions } from './top-bar-action';

@Component({
  imports: [TopBarAction, NgTemplateOutlet],
  template: `
    <header><ng-container [ngTemplateOutlet]="actions.template()" /></header>
    @if (shown()) {
      <ng-template tcTopBarAction
        ><button type="button" (click)="pressed = pressed + 1">Commands</button></ng-template
      >
    }
  `,
})
class Host {
  protected readonly actions = inject(TopBarActions);
  readonly shown = signal(true);
  pressed = 0;
}

describe('TopBarAction', () => {
  it('renders the page template in the bar with the page context, and withdraws it on destroy', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('header button') as HTMLButtonElement;
    expect(button.textContent).toBe('Commands');
    button.click();
    expect(fixture.componentInstance.pressed).toBe(1);

    fixture.componentInstance.shown.set(false);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('header button')).toBeNull();
    expect(TestBed.inject(TopBarActions).template()).toBeNull();
  });
});
