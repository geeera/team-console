import { computed, inject, Injectable, signal } from '@angular/core';
import { DeploymentStore } from '@console/entities/app-info';
import {
  EnvironmentStatusStore,
  environmentViewOf,
  projectSlugsOf,
  type RowView,
} from '@console/entities/environment';
import { ProjectsStore } from '@console/entities/project';
import type { Environment } from '@shared/contracts';

/**
 * The state the Environment setup list and its guide share (#104). Provided by the list page, so the guide in its
 * outlet reads the same rows and statuses; the network call itself is `EnvironmentStatusStore`'s, shared with the
 * Settings row.
 */
@Injectable()
export class EnvironmentScreen {
  private readonly deployment = inject(DeploymentStore);
  private readonly projects = inject(ProjectsStore);

  readonly status = inject(EnvironmentStatusStore);

  /** The selected tab (the route's `:env`). */
  readonly environment = signal<Environment>('production');
  /** The row whose guide is open, for `aria-current` and the phone layout. */
  readonly openId = signal<string | null>(null);
  /** The row to return focus to when its guide closes. */
  readonly lastOpenedId = signal<string | null>(null);

  readonly thisEnvironment = computed<Environment | null>(
    () => this.status.snapshot()?.environment ?? this.deployment.environment(),
  );

  readonly projectsFailed = computed(() => this.projects.status() === 'error');

  readonly projectSlugs = computed<readonly string[]>(() => {
    const registered = this.projects.status() === 'ready' ? this.projects.activeSlugs() : [];
    const reported =
      this.environment() === this.thisEnvironment() ? projectSlugsOf(this.status.snapshot()) : [];
    return [...new Set([...registered, ...reported])];
  });

  readonly view = computed(() =>
    environmentViewOf({
      environment: this.environment(),
      thisEnvironment: this.thisEnvironment(),
      projectSlugs: this.projectSlugs(),
      snapshot: this.status.snapshot(),
    }),
  );

  constructor() {
    void this.deployment.ensureLoaded();
    void this.projects.ready();
    void this.status.ensureLoaded();
  }

  rowById(id: string): RowView | null {
    return this.view().rows.find((view) => view.row.id === id) ?? null;
  }

  /** A project guide opened by URL before the projects loaded (or while they cannot) still finds its row. */
  projectsSettled(): boolean {
    return this.projects.status() === 'ready';
  }
}
