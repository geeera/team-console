import { DIALOG_DATA } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { inject, Injectable, Injector } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { Sheet } from '../sheet/sheet';
import { MenuPanel, type MenuPanelData, type MenuSpec } from './menu-panel';

export type { MenuGroup, MenuItem, MenuSpec } from './menu-panel';

/**
 * A menu of choices (#409): a popover next to the button that opened it on a Mac, a bottom action sheet on the
 * phone. `open` resolves with the picked item's id, or `null` when it closed without a pick (Escape, Tab, a click
 * outside, the sheet's close). Focus goes back to the opener either way; the caller then moves it where the result
 * needs it. The opener sets `aria-expanded` from the pending promise.
 */
@Injectable({ providedIn: 'root' })
export class Menu {
  private readonly overlay = inject(Overlay);
  private readonly sheet = inject(Sheet);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly injector = inject(Injector);

  open(opener: HTMLElement, spec: MenuSpec): Promise<string | null> {
    return this.breakpoints.isMatched(BREAKPOINTS.phone)
      ? this.openSheet(opener, spec)
      : this.openPopover(opener, spec);
  }

  private async openSheet(opener: HTMLElement, spec: MenuSpec): Promise<string | null> {
    const ref = this.sheet.open<string | null, MenuPanelData>(MenuPanel, {
      title: spec.title ?? spec.label,
      data: { spec, presentation: 'sheet', close: (id) => ref.close(id) },
      // The sheet's own first focus would win over the panel's: point it at the checked or first enabled item.
      autoFocus: spec.radio
        ? '.tc-menu__item[aria-checked="true"]'
        : '.tc-menu__item:not([aria-disabled="true"])',
    });
    const picked = await firstValueFrom(ref.closed, { defaultValue: null });
    opener.focus();
    return typeof picked === 'string' ? picked : null;
  }

  private openPopover(opener: HTMLElement, spec: MenuSpec): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const ref = this.overlay.create({
        positionStrategy: this.overlay
          .position()
          .flexibleConnectedTo(opener)
          .withPositions([
            { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top' },
            { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom' },
            { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
            { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
          ])
          .withPush(true),
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
        panelClass: 'tc-menu-pane',
      });
      let isDone = false;
      const close = (id: string | null): void => {
        if (isDone) {
          return;
        }
        isDone = true;
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        ref.dispose();
        opener.focus();
        resolve(id);
      };
      const injector = Injector.create({
        parent: this.injector,
        providers: [{ provide: DIALOG_DATA, useValue: { spec, presentation: 'popover', close } }],
      });
      ref.attach(new ComponentPortal(MenuPanel, null, injector));
      const subscriptions = [
        // Being subscribed makes this the overlay the CDK sends Escape to; the panel handles the key itself.
        ref.keydownEvents().subscribe(),
        ref.outsidePointerEvents().subscribe((event) => {
          const target = event.target instanceof Node ? event.target : null;
          if (target === null || !opener.contains(target)) {
            close(null);
          }
        }),
        ref.detachments().subscribe(() => close(null)),
      ];
    });
  }
}
