import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ActionsSetupStatuses, missingStepsOf } from '@console/entities/actions-setup';
import { projectActionsRouteOf } from '@console/entities/project';
import { RunnersApi } from '@console/entities/runner';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, type ChipTone, Icon, List, ListRow } from '@console/shared/ui';
import type { ProjectDispatch } from '@shared/contracts';

/** The row's chip (UX spec §4). */
export type ActionsEntryChip =
  | { readonly kind: 'off' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'on' }
  | { readonly kind: 'not-ready'; readonly n: number }
  | { readonly kind: 'unknown' };

/**
 * The project setup page's «Запуск на GitHub Actions» row (#759 UX spec §4), above the operator-only environment row.
 * It reads `GET …/dispatch` first (no mint): `pull` shows «Не включено» and never runs a readiness check; only an
 * `actions` project spends one, to show «Включено» or «Не готово: N». Hidden for a member (403) and until the dispatch
 * answered.
 */
@Component({
  selector: 'tc-project-actions-entry',
  imports: [Chip, Icon, List, ListRow, TranslocoPipe],
  template: `
    @if (dispatch(); as dispatch) {
      <tc-list [attr.aria-label]="'actions.row.title' | transloco">
        <tc-list-row [link]="route()" data-testid="project-actions-entry">
          <tc-icon tc-row-leading name="play" />
          <span tc-row-title>{{ 'actions.row.title' | transloco }}</span>
          <span tc-row-subtitle>
            {{ (chip().kind === 'not-ready' ? 'actions.row.sub.drift' : 'actions.row.sub.off') | transloco }}
          </span>
          <tc-chip tc-row-trailing data-testid="project-actions-chip" [tone]="tone()">
            @switch (chip().kind) {
              @case ('off') { {{ 'actions.row.chip.off' | transloco }} }
              @case ('on') { {{ 'actions.row.chip.on' | transloco }} }
              @case ('not-ready') { {{ 'actions.row.chip.notReady' | transloco: { n: missing() } }} }
              @case ('checking') { {{ 'actions.row.chip.checking' | transloco }} }
              @default { {{ 'actions.row.chip.unknown' | transloco }} }
            }
          </tc-chip>
        </tc-list-row>
      </tc-list>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectActionsEntry {
  private readonly runners = inject(RunnersApi);
  private readonly statuses = inject(ActionsSetupStatuses);

  readonly slug = input.required<string>();

  protected readonly dispatch = signal<ProjectDispatch | null>(null);
  protected readonly route = computed(() => projectActionsRouteOf(this.slug()));
  private readonly status = computed(() => this.statuses.of(this.slug()));

  protected readonly chip = computed<ActionsEntryChip>(() => {
    if (this.dispatch() !== 'actions') {
      return { kind: 'off' };
    }
    const status = this.status();
    const snapshot = status.snapshot();
    if (snapshot === null) {
      return status.state() === 'error' ? { kind: 'unknown' } : { kind: 'checking' };
    }
    return snapshot.ready ? { kind: 'on' } : { kind: 'not-ready', n: Math.max(1, missingStepsOf(snapshot).length) };
  });
  protected readonly missing = computed(() => {
    const chip = this.chip();
    return chip.kind === 'not-ready' ? chip.n : 0;
  });
  protected readonly tone = computed<ChipTone>(() => {
    const kind = this.chip().kind;
    return kind === 'on' ? 'success' : kind === 'not-ready' ? 'warning' : 'neutral';
  });

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.load(slug));
    });
  }

  private async load(slug: string): Promise<void> {
    this.dispatch.set(null);
    const result = await this.runners.dispatch(slug);
    if (this.slug() !== slug || !result.ok) {
      // 403 (a member) and any failure keep the row hidden: the setup page stays as it was before #759.
      return;
    }
    this.dispatch.set(result.value.dispatch);
    if (result.value.dispatch === 'actions') {
      await this.statuses.of(slug).ensureLoaded();
    }
  }
}
