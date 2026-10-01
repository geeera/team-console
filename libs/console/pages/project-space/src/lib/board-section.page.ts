import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { SprintBoard, SprintBoardProject } from '@console/widgets/sprint-board';
import { map } from 'rxjs';

/**
 * `/p/:slug/board` (#18): the project's current sprint, read-only. The slug is the parent route's parameter; the
 * `canMatch` guard has already checked it is an active project.
 */
@Component({
  selector: 'tc-board-section-page',
  imports: [SprintBoard],
  template: `
    @if (project(); as project) {
      <tc-sprint-board [project]="project" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardSectionPage {
  private readonly projects = inject(ProjectsStore);
  private readonly route = inject(ActivatedRoute);

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );

  // Equal by value: a registry refresh must not reload the board it feeds.
  protected readonly project = computed<SprintBoardProject | null>(
    () => {
      const slug = this.slug();
      const found = slug === null ? undefined : this.projects.bySlug(slug);
      return found === undefined ? null : { slug: found.slug, name: found.displayName };
    },
    { equal: (a, b) => a?.slug === b?.slug && a?.name === b?.name },
  );
}
