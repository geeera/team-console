import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Field, FieldControl, StateBlock } from '@console/shared/ui';

/**
 * The chat section until Sprint 03 (#17) replaces it: the shared empty block plus the one draft field,
 * bound to the persisted state so "restore my unsent draft" is real from day one.
 *
 * Unrouted while `CHAT_TAB_ENABLED` is off (#203) — kept, not deleted, so #17 only has to flip that switch.
 */
@Component({
  selector: 'tc-chat-placeholder-page',
  imports: [Field, FieldControl, StateBlock, TranslocoPipe],
  template: `
    <tc-state-block
      kind="empty"
      [title]="'space.placeholderTitle' | transloco"
      [description]="'space.placeholderHint' | transloco: { section: ('space.chat' | transloco) }"
    />
    <tc-field [label]="'space.draftLabel' | transloco" [hint]="'space.draftHint' | transloco">
      <textarea
        tcInput
        rows="3"
        data-testid="chat-draft"
        [value]="draft()"
        (input)="onInput($event)"
      ></textarea>
    </tc-field>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-4);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPlaceholderPage {
  private readonly state = inject(PersistedStateStore);

  readonly slug = input.required<string>();

  protected readonly draft = computed(() => this.state.projects()[this.slug()]?.chatDraft ?? '');

  protected onInput(event: Event): void {
    this.state.setChatDraft(this.slug(), (event.target as HTMLTextAreaElement).value);
  }
}
