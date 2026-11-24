import { booleanAttribute, ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * A slip of paper with a folded corner (ADR 0002): short news that arrives, stays a moment and leaves. It drops in
 * from above and, once `leaving` is set, goes back up; `left` fires when that exit has played, so the owner of the
 * note can remove it. Reduced motion swaps both moves for a short fade.
 *
 * ```html
 * <tc-paper-note [leaving]="isLeaving()" (left)="dismiss()">Updated to v1.2</tc-paper-note>
 * ```
 */
@Component({
  selector: 'tc-paper-note',
  template: `
    <span class="tc-paper-note" [class.tc-paper-note--leaving]="leaving()" (animationend)="onAnimationEnd()">
      <ng-content />
    </span>
  `,
  styleUrl: './paper-note.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaperNote {
  /** Plays the exit; set it when the note's time is up. */
  readonly leaving = input(false, { transform: booleanAttribute });
  /** The exit has finished. */
  readonly left = output<void>();

  protected onAnimationEnd(): void {
    if (this.leaving()) {
      this.left.emit();
    }
  }
}
