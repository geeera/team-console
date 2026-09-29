import { CdkDialogContainer, DialogRef } from '@angular/cdk/dialog';
import { CdkPortalOutlet } from '@angular/cdk/portal';
import { ChangeDetectionStrategy, Component, inject, InjectionToken } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { IconButton } from '../button/button';
import { Icon } from '../icon/icon';

export interface SheetFrame {
  /** Already translated; rendered as the dialog's heading and its accessible name. */
  readonly title: string;
  readonly titleId: string;
  /** Bottom sheet on the phone, centred dialog elsewhere. */
  readonly presentation: 'sheet' | 'dialog';
}

export const SHEET_FRAME = new InjectionToken<SheetFrame>('SHEET_FRAME');

/**
 * The frame every sheet and dialog gets: grab handle (sheet only), heading, close button and a
 * scrolling body with the caller's content. The CDK container underneath owns the focus trap,
 * focus restore and `aria-modal`; the host bindings are repeated here because a subclass with
 * its own template must declare them itself.
 */
@Component({
  selector: 'tc-sheet-container',
  imports: [CdkPortalOutlet, Icon, IconButton, TranslocoPipe],
  templateUrl: './sheet-container.html',
  styleUrl: './sheet-container.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-sheet',
    tabindex: '-1',
    '[class.tc-sheet--dialog]': 'frame.presentation === "dialog"',
    '[attr.id]': '_config.id',
    '[attr.role]': '_config.role',
    '[attr.aria-modal]': '_config.ariaModal',
    '[attr.aria-labelledby]': 'frame.titleId',
    '[attr.aria-describedby]': '_config.ariaDescribedBy || null',
  },
})
export class SheetContainer extends CdkDialogContainer {
  protected readonly frame = inject(SHEET_FRAME);
  private readonly ref = inject(DialogRef);

  protected close(): void {
    this._closeInteractionType = 'mouse';
    this.ref.close();
  }
}
