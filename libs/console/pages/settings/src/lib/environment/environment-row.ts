import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { proseSegmentsOf, type RowStatus, type RowView } from '@console/entities/environment';
import { TranslocoPipe } from '@console/shared/i18n';
import { CopyCode, Icon, type IconName } from '@console/shared/ui';
import type { Environment } from '@shared/contracts';
import { setupCommandOf } from '@shared/environment';

export const ROW_STATUS_ICONS: Readonly<Record<Exclude<RowStatus, 'unknown'>, IconName>> = {
  set: 'check',
  missing: 'alert',
  unseen: 'eye-off',
};

/**
 * One item of Environment setup (#104): its name (never cut), purpose and status as a word plus an icon, the whole
 * line a link to its guide. A missing item adds its one-line fix with Copy. Its own component so the list's styles
 * stay inside the per-component budget.
 */
@Component({
  selector: 'tc-environment-row',
  imports: [CopyCode, Icon, RouterLink, TranslocoPipe],
  template: `
    <a
      class="row__link"
      [routerLink]="link()"
      [attr.data-row]="view().row.id"
      [attr.aria-current]="current() ? 'page' : null"
      [attr.aria-label]="
        view().status === 'unknown'
          ? view().row.name
          : ('env.row.aria'
            | transloco: { name: view().row.name, status: ('env.st.' + view().status | transloco) })
      "
      [attr.aria-describedby]="descriptionId()"
    >
      <span class="row__text">
        <span class="row__name">{{ view().row.name }}</span>
        <span class="row__purpose" lang="ru" [id]="descriptionId()">
          @for (segment of purpose(); track $index) {
            @if (segment.code) {
              <code class="row__code">{{ segment.text }}</code>
            } @else {
              {{ segment.text }}
            }
          }
        </span>
        <span class="row__meta">
          @if (icon(); as icon) {
            <span class="row__status" [attr.data-status]="view().status" data-testid="env-status">
              <tc-icon [name]="icon" size="sm" />{{ 'env.st.' + view().status | transloco }}
            </span>
          }
          @if (view().row.item.optional) {
            <span class="row__tag">{{ 'env.st.optional' | transloco }}</span>
          }
        </span>
      </span>
      <tc-icon name="chevron-right" size="sm" class="row__chevron" />
    </a>
    @if (view().status === 'missing') {
      <div class="row__fix" data-testid="env-fix">
        <span class="row__fix-label">{{ 'env.row.fix' | transloco }}</span>
        <tc-copy-code
          [code]="setCommand()"
          [ariaLabel]="'env.row.copyAria' | transloco: { name: view().row.name }"
          [copyLabel]="'settings.common.copy' | transloco"
          [copiedLabel]="'settings.common.copied' | transloco"
          [failedNote]="'settings.common.copyFailed' | transloco"
        />
      </div>
    }
  `,
  styleUrl: './environment-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'listitem',
    'data-testid': 'env-row',
    '[class.row--missing]': 'view().status === "missing"',
  },
})
export class EnvironmentRow {
  readonly view = input.required<RowView>();
  readonly environment = input.required<Environment>();
  /** The row whose guide is open. */
  readonly current = input(false);

  protected readonly icon = computed(() => {
    const status = this.view().status;
    return status === 'unknown' ? null : ROW_STATUS_ICONS[status];
  });
  protected readonly link = computed(() => [
    '/settings/environment',
    this.environment(),
    ...this.view().row.id.split('/'),
  ]);
  protected readonly descriptionId = computed(() => `env-d-${this.view().row.id}`);
  protected readonly setCommand = computed(() => setupCommandOf(this.environment()));
  protected readonly purpose = computed(() => proseSegmentsOf(this.view().row.item.purpose));
}
