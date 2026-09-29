import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon, IconName } from '../icon/icon';
import { Spinner } from '../spinner/spinner';

export type StateKind = 'empty' | 'error' | 'loading';

const ICONS: Record<Exclude<StateKind, 'loading'>, IconName> = {
  empty: 'check',
  error: 'alert',
};

/**
 * The shared empty / error / loading block. `title` and `description` arrive already
 * translated by the caller; without a title the kit's default copy is used. The loading
 * kind is a polite live region, the error kind an alert, so screen readers hear the change.
 *
 * ```html
 * <tc-state-block kind="error" [title]="t('projects.loadFailed')">
 *   <button tc-button tc-state-action (click)="retry()">{{ t('ui.error.retry') }}</button>
 * </tc-state-block>
 * ```
 */
@Component({
  selector: 'tc-state-block',
  imports: [Icon, Spinner, TranslocoPipe],
  templateUrl: './state-block.html',
  styleUrl: './state-block.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-state-block',
    '[class.tc-state-block--error]': 'kind() === "error"',
    '[class.tc-state-block--loading]': 'kind() === "loading"',
    '[class.tc-state-block--compact]': 'compact()',
    '[attr.role]': 'role()',
    '[attr.aria-live]': 'kind() === "loading" ? "polite" : null',
    '[attr.aria-busy]': 'kind() === "loading" ? "true" : null',
  },
})
export class StateBlock {
  readonly kind = input.required<StateKind>();
  readonly title = input<string>('');
  readonly description = input<string>('');
  /** A single quiet line inside a list instead of a centred block. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly icon = computed<IconName | null>(() => {
    const kind = this.kind();
    return kind === 'loading' ? null : ICONS[kind];
  });

  protected readonly defaultTitleKey = computed(() => {
    switch (this.kind()) {
      case 'empty':
        return 'ui.empty.title';
      case 'error':
        return 'ui.error.title';
      case 'loading':
        return 'ui.loading';
    }
  });

  protected readonly role = computed(() => {
    switch (this.kind()) {
      case 'error':
        return 'alert';
      case 'loading':
        return 'status';
      case 'empty':
        return null;
    }
  });
}
