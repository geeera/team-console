import { inject, Injectable, type TemplateRef } from '@angular/core';
import { DialogRef, Sheet } from '@console/shared/ui';
import { DesignViewerDialog, type DesignViewerData, type ViewerMode } from './design-viewer-dialog';

export interface DesignViewerOptions {
  readonly slug: string;
  readonly issue: number;
  /** The design's name for the heading: the issue title, interpolated by the shell (GitHub text, plain). */
  readonly title: string;
  /**
   * Actions for the sticky footer under the screen navigation (#276: «Утвердить» / «Отклонить» from the approval
   * card). Rendered as given; the viewer never acts on the design itself.
   */
  readonly actions?: TemplateRef<unknown>;
  /** The path of the screen to open on (a tapped preview, #276); its device is chosen with it. */
  readonly screen?: string;
  /** The mode to open in; «Картинки» by default, «Все экраны» for a card's "all screens" link. */
  readonly mode?: ViewerMode;
}

/**
 * Opens a design in the console's viewer (#277): full screen on the phone, a large dialog elsewhere, on the kit's
 * dialog shell — focus goes to ✕, Escape and the scrim close, focus returns to the opener. One entry point for the
 * Artifacts rows, the approval cards (#276) and the Demo screen.
 */
@Injectable({ providedIn: 'root' })
export class DesignViewer {
  private readonly sheet = inject(Sheet);

  open(options: DesignViewerOptions): DialogRef<void> {
    const data: DesignViewerData = {
      slug: options.slug,
      issue: options.issue,
      title: options.title,
      actions: options.actions ?? null,
      screen: options.screen ?? null,
      mode: options.mode ?? 'images',
    };
    return this.sheet.open<void, DesignViewerData>(DesignViewerDialog, {
      title: options.title,
      data,
      size: 'full',
      autoFocus: '.tc-sheet__close',
    });
  }
}
