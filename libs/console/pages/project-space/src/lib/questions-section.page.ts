import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { QuestionList } from '@console/widgets/question-list';
import type { NeedsYouProjectRef } from '@shared/contracts';
import { map } from 'rxjs';

/**
 * `/p/:slug/questions` (#16): the project's waiting items in the plugin's inbox order, answerable in place. The
 * slug is the parent route's parameter; the `canMatch` guard has already checked it is an active project.
 */
@Component({
  selector: 'tc-questions-section-page',
  imports: [QuestionList],
  template: `
    @if (project(); as project) {
      <tc-question-list [project]="project" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestionsSectionPage {
  private readonly projects = inject(ProjectsStore);
  private readonly route = inject(ActivatedRoute);

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );

  // Equal by value: a registry refresh must not reload the list it feeds.
  protected readonly project = computed<NeedsYouProjectRef | null>(
    () => {
      const slug = this.slug();
      const found = slug === null ? undefined : this.projects.bySlug(slug);
      return found === undefined ? null : { slug: found.slug, name: found.displayName };
    },
    { equal: (a, b) => a?.slug === b?.slug && a?.name === b?.name },
  );
}
