import { computed, inject, Injectable, signal } from '@angular/core';
import { ItemsApi } from '@console/entities/item';
import { isOnConsoleTracker, ProjectsStore } from '@console/entities/project';
import type { ProjectDto } from '@shared/contracts';

type Verdict = 'checking' | 'allowed' | 'refused';

/**
 * Who sees New task (#107): only projects on the console tracker take one, and only an identity the route matrix
 * lets read a project's sprints may write there — the service identity (Playwright) and jobs are refused before
 * anything is read, so the entry stays hidden for them instead of failing on Create. Each project is probed once per
 * session; anything but a refusal (offline, an error) shows the entry, and the form says what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class QuickTaskAccess {
  private readonly projects = inject(ProjectsStore);
  private readonly api = inject(ItemsApi);
  private readonly verdicts = signal<ReadonlyMap<string, Verdict>>(new Map());

  readonly trackerProjects = computed((): readonly ProjectDto[] =>
    this.projects.active().filter((project) => isOnConsoleTracker(project)),
  );

  /** `slug` inside a project; `null` on Needs you, where any project on the tracker will do. */
  canCreate(slug: string | null): boolean {
    const target = this.targetOf(slug);
    return target !== null && this.verdicts().get(target) === 'allowed';
  }

  /** Starts the probe for the entry's project; cheap to call again. */
  check(slug: string | null): void {
    const target = this.targetOf(slug);
    if (target === null || this.verdicts().has(target)) {
      return;
    }
    this.set(target, 'checking');
    void this.probe(target);
  }

  private targetOf(slug: string | null): string | null {
    const projects = this.trackerProjects();
    if (slug === null) {
      return projects[0]?.slug ?? null;
    }
    return projects.some((project) => project.slug === slug) ? slug : null;
  }

  private async probe(slug: string): Promise<void> {
    const read = await this.api.sprints(slug);
    this.set(slug, !read.ok && read.reason === 'forbidden' ? 'refused' : 'allowed');
  }

  private set(slug: string, verdict: Verdict): void {
    this.verdicts.update((before) => new Map(before).set(slug, verdict));
  }
}
