import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { PaperNote } from '@console/shared/ui';
import { AppUpdates } from './app-updates';

/** How long the note stays on the page before it leaves (#347). */
export const UPDATED_NOTE_MS = 3_000;

/**
 * «Обновлено до vX.Y» (#347): a paper note with a folded corner that drops in from the top of the screen after the
 * app reloads onto a new version, stays a moment and goes up again. The host is a live region that exists before the
 * note does, so the news is announced. Under reduced motion it only fades in and out.
 */
@Component({
  selector: 'tc-updated-note',
  imports: [PaperNote, TranslocoPipe],
  template: `
    @if (updates.justUpdatedTo(); as version) {
      <tc-paper-note [leaving]="isLeaving()" (left)="updates.dismissUpdated()" data-testid="updated-note">
        {{ 'app.update.done' | transloco: { version } }}
      </tc-paper-note>
    }
  `,
  styles: `
    :host {
      position: fixed;
      inset: var(--safe-top) 0 auto;
      z-index: var(--z-chrome);
      display: flex;
      justify-content: center;
      padding: var(--space-3) var(--space-4) 0;
      pointer-events: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status' },
})
export class UpdatedNote {
  protected readonly updates = inject(AppUpdates);
  protected readonly isLeaving = signal(false);

  constructor() {
    const destroyRef = inject(DestroyRef);
    effect((onCleanup) => {
      if (this.updates.justUpdatedTo() === null) {
        return;
      }
      untracked(() => this.isLeaving.set(false));
      const timer = setTimeout(() => this.isLeaving.set(true), UPDATED_NOTE_MS);
      onCleanup(() => clearTimeout(timer));
    });
    destroyRef.onDestroy(() => this.updates.dismissUpdated());
  }
}
