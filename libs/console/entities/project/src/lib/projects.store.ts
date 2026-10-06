import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { isProblemDetails, isSnoozeDto, ProblemDetails, ProjectDto, type SnoozeDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export const PROJECTS_URL = '/api/v1/projects';

export type ProjectsStatus = 'idle' | 'loading' | 'ready' | 'error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjectDto(value: unknown): value is ProjectDto {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['slug'] === 'string' &&
    typeof value['repo'] === 'string' &&
    typeof value['displayName'] === 'string' &&
    (value['routineId'] === null || typeof value['routineId'] === 'string') &&
    typeof value['addedAt'] === 'string' &&
    (value['archivedAt'] === null || typeof value['archivedAt'] === 'string') &&
    (value['snooze'] === undefined || isSnoozeDto(value['snooze']))
  );
}

export function isProjectDtoList(value: unknown): value is ProjectDto[] {
  return Array.isArray(value) && value.every(isProjectDto);
}

/** The Problem Details of a failed load, or a synthetic one when the body was not a problem. */
function problemOf(error: unknown): ProblemDetails {
  if (error instanceof HttpErrorResponse && isProblemDetails(error.error)) {
    return error.error;
  }
  const status = error instanceof HttpErrorResponse ? error.status : 0;
  return { type: 'about:blank', title: 'projects-unavailable', status };
}

/**
 * The registry's project list (#15) as the client sees it. `ready()` is what route guards await:
 * it starts the first load and resolves once the list is known — or known to be unavailable, in
 * which case `status()` is `error` and `isActive()` is false for every slug.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsStore {
  private readonly http = inject(HttpClient);

  private readonly list = signal<readonly ProjectDto[]>([]);
  private pending: Promise<void> | null = null;

  readonly status = signal<ProjectsStatus>('idle');
  /** When the list was last loaded from the Worker (ISO 8601); the offline note quotes it. */
  readonly loadedAt = signal<string | null>(null);
  readonly problem = signal<ProblemDetails | null>(null);
  /** Active projects only; archived ones never reach the switcher or a space. */
  readonly active = computed(() => this.list().filter((project) => project.archivedAt === null));
  readonly activeSlugs = computed(() => this.active().map((project) => project.slug));
  readonly hasProjects = computed(() => this.active().length > 0);

  ready(): Promise<void> {
    if (this.status() === 'idle') {
      return this.load();
    }
    return this.pending ?? Promise.resolve();
  }

  /** Loads the list; a failure is recorded on `status()`/`problem()`, never thrown into a guard. */
  load(): Promise<void> {
    if (this.pending !== null) {
      return this.pending;
    }
    this.status.set('loading');
    this.pending = (async () => {
      try {
        const body = await firstValueFrom(this.http.get<unknown>(PROJECTS_URL));
        if (!isProjectDtoList(body)) {
          throw new Error('projects: unexpected response shape');
        }
        this.list.set(body);
        this.loadedAt.set(new Date().toISOString());
        this.problem.set(null);
        this.status.set('ready');
      } catch (error: unknown) {
        this.problem.set(problemOf(error));
        this.status.set('error');
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** A project the Worker just created (201 body): listed at once, without a second round trip. */
  upsert(project: ProjectDto): void {
    this.list.update((list) => [...list.filter((item) => item.slug !== project.slug), project]);
  }

  /** A snooze the Worker just stored or cleared (#221): the sidebar's bell follows at once. */
  applySnooze(slug: string, snooze: SnoozeDto): void {
    this.list.update((list) => list.map((item) => (item.slug === slug ? { ...item, snooze } : item)));
  }

  /** A project the Worker just archived (204): it leaves the switcher, the badges and Settings at once. */
  remove(slug: string): void {
    this.list.update((list) => list.filter((item) => item.slug !== slug));
  }

  /**
   * The registered project (active or archived) that holds this repository or slug, read from the Worker with
   * `?include=archived` — how New project tells "already on the list" from "archived" after a 409 (#24).
   */
  async findRegistered(repo: string, slug: string): Promise<ProjectDto | null> {
    const body = await firstValueFrom(
      this.http.get<unknown>(PROJECTS_URL, { params: new HttpParams().set('include', 'archived') }),
    );
    if (!isProjectDtoList(body)) {
      throw new Error('projects: unexpected response shape');
    }
    const wanted = repo.toLowerCase();
    return body.find((project) => project.repo.toLowerCase() === wanted || project.slug === slug) ?? null;
  }

  bySlug(slug: string): ProjectDto | undefined {
    return this.active().find((project) => project.slug === slug);
  }

  isActive(slug: string): boolean {
    return this.bySlug(slug) !== undefined;
  }
}
