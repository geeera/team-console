import { Dialog } from '@angular/cdk/dialog';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Button, Icon, IconButton, isLetterShortcut } from '@console/shared/ui';
import { QuickTask } from './quick-task';
import { QuickTaskAccess } from './quick-task-access';

/**
 * The New task entry (#107): `+` in the phone's top bar (`compact`), a «Новая задача» button with T on a Mac. The ochre
 * dot says an unsent draft waits, and so does the name. Shown only where a task can be created (`QuickTaskAccess`).
 * T opens it from anywhere on the screen but a text field, while no dialog is open.
 */
@Component({
  selector: 'tc-new-task-button',
  imports: [Button, Icon, IconButton, TranslocoPipe],
  template: `
    @if (isShown()) {
      @if (compact()) {
        <button
          tc-icon-button
          type="button"
          data-testid="new-task-open"
          aria-haspopup="dialog"
          [dot]="hasDraft()"
          [attr.aria-label]="label() | transloco"
          (click)="open()"
        >
          <tc-icon name="plus" />
        </button>
      } @else {
        <button
          tc-button
          type="button"
          data-testid="new-task-open"
          aria-haspopup="dialog"
          aria-keyshortcuts="T"
          [dot]="hasDraft()"
          [attr.aria-label]="label() | transloco"
          (click)="open()"
        >
          <tc-icon name="plus" size="sm" />
          {{ 'quickTask.new' | transloco }}
          <kbd class="tc-kbd" aria-hidden="true">T</kbd>
        </button>
      }
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class NewTaskButton {
  private readonly access = inject(QuickTaskAccess);
  private readonly quickTask = inject(QuickTask);
  private readonly drafts = inject(PersistedStateStore);
  private readonly dialog = inject(Dialog);

  /** The project the owner is in; `null` on Needs you. */
  readonly slug = input<string | null>(null);
  /** The phone's top-bar icon; it takes no shortcut. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly isShown = computed(() => this.access.canCreate(this.slug()));
  protected readonly hasDraft = computed(() => this.drafts.quickTaskDraft() !== undefined);
  protected readonly label = computed(() => (this.hasDraft() ? 'quickTask.newDraft' : 'quickTask.new'));

  constructor() {
    effect(() => {
      const slug = this.slug();
      // Re-run once the project list arrives: the probe needs a project on the tracker.
      this.access.trackerProjects();
      untracked(() => this.access.check(slug));
    });
  }

  protected open(): void {
    void this.quickTask.open(this.slug());
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.compact() || !this.isShown() || this.dialog.openDialogs.length > 0) {
      return;
    }
    if (isLetterShortcut(event, 'KeyT', ['t', 'T', 'е', 'Е'])) {
      event.preventDefault();
      this.open();
    }
  }
}
