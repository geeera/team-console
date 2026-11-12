import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { itemNumberOfSegment } from '@console/entities/item';
import { ProjectsStore } from '@console/entities/project';
import { BREAKPOINTS, PinnedColumn } from '@console/shared/ui';
import { TaskScreen } from '@console/widgets/task-screen';
import { map } from 'rxjs';
import { BoardSectionPage } from './board-section.page';

/**
 * `/p/:slug/t/:n` (#435, #409 §1): a task of the console tracker. On a Mac the board stays on the left and the task
 * is a pane beside it (not modal: Tab leaves it into the board, Escape closes it); on the iPhone it is its own page
 * with Back. A number that is not a positive integer is "no such task", the same as an unknown one. Lazy: this file
 * is reached only through the route's `loadComponent`, so the task screen never weighs on the board.
 */
@Component({
  selector: 'tc-task-section-page',
  imports: [BoardSectionPage, PinnedColumn, TaskScreen],
  template: `
    @if (!isPhone()) {
      <div class="task-section__board"><tc-board-section-page /></div>
    }
    @if (project(); as project) {
      <tc-task-screen
        class="task-section__task"
        tcPinnedColumn
        [slug]="project.slug"
        [number]="number() ?? 0"
        [projectName]="project.displayName"
        [presentation]="isPhone() ? 'page' : 'pane'"
        (closed)="close()"
        (keydown.escape)="onEscape($event)"
      />
    }
  `,
  styleUrl: './task-section.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'task-section', '[class.task-section--phone]': 'isPhone()' },
})
export class TaskSectionPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsStore);
  private readonly breakpoints = inject(BreakpointObserver);

  private readonly slug = toSignal(
    (this.route.parent ?? this.route).paramMap.pipe(map((params) => params.get('slug'))),
    { initialValue: null },
  );
  protected readonly number = toSignal(
    this.route.paramMap.pipe(map((params) => itemNumberOfSegment(params.get('n')))),
    { initialValue: null },
  );
  protected readonly project = computed(() => {
    const slug = this.slug();
    return slug === null ? undefined : this.projects.bySlug(slug);
  });
  protected readonly isPhone = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );

  protected close(): void {
    const slug = this.slug();
    if (slug !== null) {
      void this.router.navigate(['/p', slug, 'board']);
    }
  }

  protected onEscape(event: Event): void {
    if (this.isPhone() || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    this.close();
  }
}
