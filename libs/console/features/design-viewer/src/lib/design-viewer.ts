import { inject, Injectable, type TemplateRef } from '@angular/core';
import { DialogRef, Sheet } from '@console/shared/ui';
import { DesignViewerDialog, type DesignViewerData } from './design-viewer-dialog';

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
    };
    return this.sheet.open<void, DesignViewerData>(DesignViewerDialog, {
      title: options.title,
      data,
      size: 'full',
      autoFocus: '.tc-sheet__close',
    });
  }
}
