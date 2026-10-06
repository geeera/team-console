import { CdkDialogContainer, DialogRef } from '@angular/cdk/dialog';
import { CdkPortalOutlet } from '@angular/cdk/portal';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  InjectionToken,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { SheetFooterSlot } from './sheet-footer';

export interface SheetFrame {
  /** Already translated; rendered as the dialog's heading and its accessible name. */
  readonly title: string;
  readonly titleId: string;
  /** Bottom sheet on the phone, centred dialog elsewhere. */
  readonly presentation: 'sheet' | 'dialog';
}

export const SHEET_FRAME = new InjectionToken<SheetFrame>('SHEET_FRAME');

/**
 * The frame every sheet and dialog gets: grab handle (sheet only), heading, close button, a scrolling body with the
 * caller's content and, when the content declares one (`tcSheetFooter`), a footer of actions that does not scroll.
 * The CDK container underneath owns the focus trap, focus restore and `aria-modal`; the host bindings are repeated
 * here because a subclass with its own template must declare them itself.
 */
@Component({
  selector: 'tc-sheet-container',
  imports: [CdkPortalOutlet, Icon, IconButton, NgTemplateOutlet, TranslocoPipe],
  templateUrl: './sheet-container.html',
  styleUrl: './sheet-container.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-sheet',
    tabindex: '-1',
    '[class.tc-sheet--dialog]': 'frame.presentation === "dialog"',
    '[class.tc-sheet--with-foot]': 'footer.template() !== null',
    '[attr.id]': '_config.id',
    '[attr.role]': '_config.role',
    '[attr.aria-modal]': '_config.ariaModal',
    '[attr.aria-labelledby]': 'frame.titleId',
    '[attr.aria-describedby]': '_config.ariaDescribedBy || null',
  },
})
export class SheetContainer extends CdkDialogContainer {
  protected readonly frame = inject(SHEET_FRAME);
  protected readonly footer = inject(SheetFooterSlot, { optional: true }) ?? new SheetFooterSlot();
  private readonly ref = inject(DialogRef);
  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');

  /** Whether the body overflows: only then is it a tab stop (the designer's axe finding on #194). */
  protected readonly scrollable = signal(false);

  constructor() {
    super();
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const body = this.body().nativeElement;
      const measure = (): void => this.scrollable.set(body.scrollHeight > body.clientHeight + 1);
      measure();
      if (typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(measure);
      observer.observe(body);
      observer.observe(this.content().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected close(): void {
    // Honour the same lock as Escape and the scrim (a confirm dialog sets it while its action runs).
    if (this.ref.disableClose) {
      return;
    }
    this._closeInteractionType = 'mouse';
    this.ref.close();
  }
}
