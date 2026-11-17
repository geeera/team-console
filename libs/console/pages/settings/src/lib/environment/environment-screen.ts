import { computed, effect, inject, Injectable, signal, untracked, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { DeploymentStore } from '@console/entities/app-info';
import {
  EnvironmentStatusStore,
  environmentViewOf,
  ProjectEnvironmentStatuses,
  projectEnvironmentViewOf,
  type EnvironmentStatusState,
  type ProjectEnvironmentView,
  type RowView,
} from '@console/entities/environment';
import {
  projectEnvironmentGuideRouteOf,
  projectEnvironmentRouteOf,
  ProjectsStore,
} from '@console/entities/project';
import { isEnvironment, type Environment } from '@shared/contracts';
import { map } from 'rxjs';
import { CONSOLE_ENVIRONMENT_PATH } from './environment-paths';

/** A translated line: its key and params, for the template's `transloco` pipe. */
export interface CopyLine {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * What a guide asks the list it opened from (#104, #750): the row behind its URL, where Back goes and what the
 * not-found heading says. Provided by the list page — the operator screen or a project's — so the guide in its
 * outlet reads the same rows and statuses.
 */
@Injectable()
export abstract class EnvironmentScreen {
  protected readonly deployment = inject(DeploymentStore);

  /** The one status call the screen reads. */
  abstract readonly status: Signal<EnvironmentStatusState>;

  /** The row whose guide is open, for `aria-current` and the phone layout. */
  readonly openId = signal<string | null>(null);
  /** The row to return focus to when its guide closes. */
  readonly lastOpenedId = signal<string | null>(null);

  readonly thisEnvironment = computed<Environment | null>(
    () => this.status().snapshot()?.environment ?? this.deployment.environment(),
  );

  /** The environment a guide's URL names (the operator screen: its selected tab); null for an unknown one. */
  abstract guideEnvironmentOf(param: string | undefined): Environment | null;
  /** The id a guide's route params name. */
  abstract guideIdOf(params: { readonly place: string | undefined; readonly name: string }): string;
  abstract rowAt(environment: Environment, id: string): RowView | null;
  /** Router commands of a row's guide. */
  abstract guideRouteOf(environment: Environment, row: RowView): readonly string[];
  /** Where the guide's Back and close go. */
  abstract listRouteOf(environment: Environment): readonly string[];
  abstract backLineOf(environment: Environment): CopyLine;
  abstract notFoundLineOf(environment: string): CopyLine;
}

/** `/admin/environment/:env` (#750): this console's own rows, one tab per environment. */
@Injectable()
export class ConsoleEnvironmentScreen extends EnvironmentScreen {
  readonly status = signal<EnvironmentStatusState>(inject(EnvironmentStatusStore)).asReadonly();

  /** The selected tab (the route's `:env`). */
  readonly environment = signal<Environment>('production');

  readonly view = computed(() =>
    environmentViewOf({
      environment: this.environment(),
      thisEnvironment: this.thisEnvironment(),
      snapshot: this.status().snapshot(),
    }),
  );

  constructor() {
    super();
    void this.deployment.ensureLoaded();
    void this.status().ensureLoaded();
  }

  guideEnvironmentOf(): Environment {
    return this.environment();
  }

  guideIdOf(params: { readonly place: string | undefined; readonly name: string }): string {
    return `${params.place ?? ''}/${params.name}`;
  }

  rowAt(environment: Environment, id: string): RowView | null {
    return environment === this.environment()
      ? (this.view().rows.find((view) => view.row.id === id) ?? null)
      : null;
  }

  guideRouteOf(environment: Environment, row: RowView): readonly string[] {
    return [CONSOLE_ENVIRONMENT_PATH, environment, ...row.row.id.split('/')];
  }

  listRouteOf(environment: Environment): readonly string[] {
    return [CONSOLE_ENVIRONMENT_PATH, environment];
  }

  backLineOf(environment: Environment): CopyLine {
    return { key: 'env.g.back', params: { env: environment } };
  }

  notFoundLineOf(environment: string): CopyLine {
    return { key: 'env.g.notFound.title', params: { env: environment } };
  }
}

/**
 * `/settings/projects/:slug/environment` (#750): one project's rows only, in a section per environment that has
 * any. Its status call is that project's alone (`?project=<slug>`), never the console's.
 */
@Injectable()
export class ProjectEnvironmentScreen extends EnvironmentScreen {
  private readonly statuses = inject(ProjectEnvironmentStatuses);
  private readonly projects = inject(ProjectsStore);

  /** The page route's `:slug`, which the list page and its guide share. */
  readonly slug = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('slug') ?? '')), {
    requireSync: true,
  });
  readonly status = computed(() => this.statuses.of(this.slug()));
  /** The project's display name once the projects loaded, its slug until then. */
  readonly projectName = computed(() => this.projects.bySlug(this.slug())?.displayName ?? this.slug());

  readonly view = computed<ProjectEnvironmentView>(() =>
    projectEnvironmentViewOf({
      slug: this.slug(),
      thisEnvironment: this.thisEnvironment(),
      snapshot: this.status().snapshot(),
    }),
  );

  constructor() {
    super();
    void this.deployment.ensureLoaded();
    void this.projects.ready();
    effect(() => {
      const status = this.status();
      untracked(() => void status.ensureLoaded());
    });
  }

  guideEnvironmentOf(param: string | undefined): Environment | null {
    return isEnvironment(param) ? param : null;
  }

  guideIdOf(params: { readonly place: string | undefined; readonly name: string }): string {
    return `project/${this.slug()}/${params.name}`;
  }

  rowAt(environment: Environment, id: string): RowView | null {
    const section = this.view().sections.find((candidate) => candidate.environment === environment);
    return (
      [...(section?.required ?? []), ...(section?.optional ?? [])].find((view) => view.row.id === id) ?? null
    );
  }

  guideRouteOf(environment: Environment, row: RowView): readonly string[] {
    return projectEnvironmentGuideRouteOf(this.slug(), environment, row.row.name);
  }

  listRouteOf(): readonly string[] {
    return projectEnvironmentRouteOf(this.slug());
  }

  backLineOf(): CopyLine {
    return { key: 'env.project.g.back', params: { project: this.projectName() } };
  }

  notFoundLineOf(environment: string): CopyLine {
    return { key: 'env.project.g.notFound', params: { project: this.projectName(), env: environment } };
  }
}
