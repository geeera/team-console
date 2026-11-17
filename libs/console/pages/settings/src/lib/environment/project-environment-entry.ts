import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import {
  EnvironmentCopy,
  ProjectEnvironmentStatuses,
  projectEntryChipOf,
} from '@console/entities/environment';
import { projectEnvironmentRouteOf } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { Chip, Icon, List, ListRow } from '@console/shared/ui';
import { PROJECT_SECRETS_ENVIRONMENT } from '@shared/environment';

/**
 * The project setup page's "Project environment" row (#750 UX spec §5): hidden until the project's own status call
 * answered 200 in this session (the operator signal), so a customer never sees it; then the #104 chip — Checking…,
 * the count, All set, or Not checked after a failure.
 */
@Component({
  selector: 'tc-project-environment-entry',
  imports: [Chip, Icon, List, ListRow, TranslocoPipe],
  template: `
    @if (isVisible()) {
      <tc-list [attr.aria-label]="'env.project.entry.row' | transloco">
        <tc-list-row [link]="route()" data-testid="project-env-entry">
          <tc-icon tc-row-leading name="key" />
          <span tc-row-title>{{ 'env.project.entry.row' | transloco }}</span>
          <span tc-row-subtitle>{{ 'env.project.entry.sub' | transloco: { env: environment } }}</span>
          <tc-chip
            tc-row-trailing
            data-testid="project-env-chip"
            [tone]="chip().kind === 'missing' ? 'warning' : chip().kind === 'ok' ? 'success' : 'neutral'"
          >
            @switch (chip().kind) {
              @case ('missing') {
                {{ 'env.entry.missing' | transloco: { n: missing() } }}
              }
              @case ('ok') {
                {{ 'env.entry.ok' | transloco }}
              }
              @case ('checking') {
                {{ 'env.entry.checking' | transloco }}
              }
              @default {
                {{ 'env.entry.unknown' | transloco }}
              }
            }
          </tc-chip>
        </tc-list-row>
      </tc-list>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectEnvironmentEntry {
  private readonly statuses = inject(ProjectEnvironmentStatuses);
  private readonly copy = inject(EnvironmentCopy);

  readonly slug = input.required<string>();

  /** Where the project's secrets live: the row's subtitle names it without loading the manifest. */
  protected readonly environment = PROJECT_SECRETS_ENVIRONMENT;
  private readonly status = computed(() => this.statuses.of(this.slug()));
  protected readonly route = computed(() => projectEnvironmentRouteOf(this.slug()));
  protected readonly isVisible = computed(() => this.copy.loaded() && this.status().snapshot() !== null);
  protected readonly chip = computed(() =>
    projectEntryChipOf(this.status().state(), this.status().snapshot()),
  );
  protected readonly missing = computed(() => {
    const chip = this.chip();
    return chip.kind === 'missing' ? chip.n : 0;
  });

  constructor() {
    void this.copy.ready();
    effect(() => {
      const status = this.status();
      untracked(() => void status.ensureLoaded());
    });
  }
}
