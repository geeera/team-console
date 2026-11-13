import { ChangeDetectionStrategy, Component, computed, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { isOnConsoleTracker, ProjectsStore } from '@console/entities/project';
import { CreateSprint } from '@console/features/create-sprint';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, Toaster } from '@console/shared/ui';
import { BoardFolders, SprintBoard, SprintBoardProject } from '@console/widgets/sprint-board';
import { map } from 'rxjs';

/**
 * `/p/:slug/board` (#18): the project's current sprint, read-only. The slug is the parent route's parameter; the
 * `canMatch` guard has already checked it is an active project. `?tab=pr|runs` opens the narrow layout on that tab;
 * `?section=next|backlog` (#562) opens and focuses that folder.
 */
@Component({
  selector: 'tc-board-section-page',
  imports: [BoardFolders, Button, Icon, SprintBoard, TranslocoPipe],
  template: `
    @if (isTracker()) {
      <div class="board-section__plan">
        <button tc-button type="button" data-testid="create-sprint" (click)="createSprint()">
          <tc-icon name="plus" size="sm" />
          {{ 'sprintNew.create' | transloco }}
        </button>
      </div>
    }
    @if (project(); as project) {
      <tc-sprint-board [project]="project" [initialTab]="tab()" />
      @if (project.isOnConsoleTracker) {
        <!-- #557: the next sprints and the backlog, under the current sprint and its lists. -->
        <tc-board-folders
          class="board-section__folders"
          [slug]="project.slug"
          [initialSection]="section()"
          (createSprint)="createSprint()"
        />
      }
    }
  `,
  styles: `
    .board-section__plan {
      display: flex;
      justify-content: flex-end;
      margin-bottom: var(--space-3);
    }

    .board-section__folders {
      margin-top: var(--space-6);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardSectionPage {
  private readonly projects = inject(ProjectsStore);
  private readonly sprints = inject(CreateSprint);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly route = inject(ActivatedRoute);
  private readonly folders = viewChild(BoardFolders);

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );

  /** A deep link's `?tab=pr|runs` (#275); the board ignores anything else. */
  protected readonly tab = toSignal(this.route.queryParamMap.pipe(map((params) => params.get('tab'))), {
    initialValue: null,
  });

  /** A deep link's `?section=next|backlog` (#562), read the same way; `BoardFolders` ignores anything else. */
  protected readonly section = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('section'))),
    { initialValue: null },
  );

  /**
   * A console-tracker project (#435) plans its sprints here: Create a sprint. Its board reads the current sprint from
   * the tracker (#556); a GitHub-mode project keeps #18's board.
   */
  protected readonly isTracker = computed(() => {
    const slug = this.slug();
    return slug !== null && isOnConsoleTracker(this.projects.bySlug(slug));
  });

  protected async createSprint(): Promise<void> {
    const slug = this.slug();
    if (slug === null) {
      return;
    }
    const sprint = await this.sprints.open({ slug });
    if (sprint !== null) {
      this.toaster.show(this.transloco.translate('sprintNew.doneVerb', { sprint: sprint.title }));
      await this.folders()?.reload();
    }
  }

  // Equal by value: a registry refresh must not reload the board it feeds.
  protected readonly project = computed<SprintBoardProject | null>(
    () => {
      const slug = this.slug();
      const found = slug === null ? undefined : this.projects.bySlug(slug);
      return found === undefined
        ? null
        : { slug: found.slug, name: found.displayName, isOnConsoleTracker: isOnConsoleTracker(found) };
    },
    {
      equal: (a, b) =>
        a?.slug === b?.slug && a?.name === b?.name && a?.isOnConsoleTracker === b?.isOnConsoleTracker,
    },
  );
}
