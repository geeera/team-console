import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Icon } from '@console/shared/ui';

/**
 * One section card of Settings › Team (#688): a `section` with its `h2`. On the phone (`foldable`) the heading is a
 * disclosure button that still shows the section's value when folded ("API key", "$200 a month"), so the page is a
 * short list of lines; elsewhere the section is always open. The owner's answer on the design (2026-11-17): keep the
 * iPhone folding of Access, Limits and Rules.
 */
@Component({
  selector: 'tc-team-section',
  imports: [Icon],
  template: `
    <h2 class="team-section__title" [id]="headingId()">
      @if (foldable()) {
        <button
          type="button"
          class="team-section__toggle"
          [attr.aria-expanded]="open() ? 'true' : 'false'"
          [attr.aria-controls]="bodyId()"
          [attr.data-testid]="'section-toggle-' + name()"
          (click)="open.set(!open())"
        >
          <span class="team-section__words">
            <span>{{ title() }}</span>
            @if (!open() && summary() !== '') {
              <span class="team-section__summary">{{ summary() }}</span>
            }
          </span>
          <tc-icon [name]="open() ? 'chevron-down' : 'chevron-right'" size="sm" />
        </button>
      } @else {
        {{ title() }}
      }
    </h2>
    <div class="team-section__body" [id]="bodyId()" [hidden]="foldable() && !open()">
      <ng-content />
    </div>
  `,
  styleUrl: './team-section.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'team-section',
    '[attr.aria-labelledby]': 'headingId()',
    '[attr.data-testid]': '"section-" + name()',
    '[attr.aria-busy]': 'busy() ? "true" : null',
  },
})
export class TeamSection {
  readonly name = input.required<string>();
  readonly title = input.required<string>();
  /** The section's value in one line, shown while folded. */
  readonly summary = input('');
  readonly foldable = input(false);
  readonly open = model(true);
  readonly busy = input(false);

  protected readonly headingId = computed(() => `tc-team-section-${this.name()}`);
  protected readonly bodyId = computed(() => `tc-team-section-${this.name()}-body`);
}
