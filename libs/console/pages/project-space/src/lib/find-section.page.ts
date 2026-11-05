import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { FindItem, type FindProject } from '@console/features/find-item';
import type { ProjectDto } from '@shared/contracts';
import { map } from 'rxjs';

function findProjectOf(project: ProjectDto): FindProject {
  return {
    slug: project.slug,
    name: project.displayName,
    repo: project.repo,
    keyPrefix: project.keyPrefix ?? null,
    isOnConsole: project.tracker !== undefined && project.tracker !== 'github',
  };
}

/** `/p/:slug/find?q=` (#435, #409 §2.4): Find a task in this project. Lazy, like the task screen. */
@Component({
  selector: 'tc-find-section-page',
  imports: [FindItem],
  template: `
    @if (here(); as here) {
      <tc-find-item [here]="here" [projects]="others()" [initialQuery]="query() ?? ''" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FindSectionPage {
  private readonly route = inject(ActivatedRoute);
  private readonly projects = inject(ProjectsStore);

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );
  protected readonly query = toSignal(this.route.queryParamMap.pipe(map((params) => params.get('q'))), {
    initialValue: null,
  });
  protected readonly here = computed(() => {
    const slug = this.slug();
    const project = slug === null ? undefined : this.projects.bySlug(slug);
    return project === undefined ? null : findProjectOf(project);
  });
  protected readonly others = computed(() =>
    this.projects
      .active()
      .filter((project) => project.slug !== this.slug())
      .map(findProjectOf),
  );
}
