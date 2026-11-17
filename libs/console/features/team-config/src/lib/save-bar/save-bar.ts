import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoPluralPipe } from '@console/shared/i18n';
import { Button } from '@console/shared/ui';

/**
 * The sticky "Unsaved changes" bar of Settings › Team (#688, UX spec §2.2): the count, `Discard` and `Review and
 * save`. Nothing saves on change; this bar is the only way to the review. When the review cannot open (offline, a
 * value out of its bound) the button stays focusable, `aria-disabled`, with the reason under the count.
 */
@Component({
  selector: 'tc-save-bar',
  imports: [Button, TranslocoPipe, TranslocoPluralPipe],
  template: `
    <div class="save-bar__text">
      <p class="save-bar__count" data-testid="save-bar-count">
        {{ 'teamConfig.bar.count' | translocoPlural: count() }}
      </p>
      @if (offReason(); as reason) {
        <p class="save-bar__reason" data-testid="save-bar-reason" [id]="reasonId">{{ reason }}</p>
      }
    </div>
    <div class="save-bar__actions">
      <button tc-button type="button" data-testid="save-bar-discard" (click)="discard.emit()">
        {{ 'teamConfig.bar.discard' | transloco }}
      </button>
      <button
        tc-button
        variant="primary"
        type="button"
        data-testid="save-bar-review"
        [off]="offReason() !== null"
        [attr.aria-disabled]="offReason() === null ? null : 'true'"
        [attr.aria-describedby]="offReason() === null ? null : reasonId"
        (click)="offReason() === null && review.emit()"
      >
        {{ 'teamConfig.bar.review' | transloco }}
      </button>
    </div>
  `,
  styleUrl: './save-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'save-bar',
    role: 'region',
    '[attr.aria-label]': 'label()',
    'data-testid': 'save-bar',
  },
})
export class SaveBar {
  readonly count = input.required<number>();
  /** The region's name ("Unsaved changes"), already translated. */
  readonly label = input.required<string>();
  /** Why the review cannot open now, already translated; `null` when it can. */
  readonly offReason = input<string | null>(null);

  readonly review = output<void>();
  readonly discard = output<void>();

  protected readonly reasonId = 'tc-save-bar-reason';
}
