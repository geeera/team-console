import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';
import { QuestionList } from '@console/widgets/question-list';

/**
 * `/needs-you` (ADR 0001 decision 24, #16): every active project's waiting items, each tagged with its project and
 * answerable in place. With no registered project it is the shell's empty state and points to Settings (#24).
 */
@Component({
  selector: 'tc-needs-you-page',
  imports: [Button, QuestionList, RouterLink, StateBlock, TranslocoPipe],
  template: `
    <div class="tc-page">
      <h1 class="tc-page__title">{{ 'needsYou.title' | transloco }}</h1>
      @if (projects.status() !== 'ready') {
        <tc-state-block kind="loading" [title]="'shell.loading' | transloco" />
      } @else if (projects.hasProjects()) {
        <tc-question-list />
      } @else {
        <tc-state-block
          kind="empty"
          data-testid="no-projects"
          [title]="'shell.noProjects' | transloco"
          [description]="'shell.noProjectsHint' | transloco"
        >
          <a tc-button tc-state-action variant="primary" routerLink="/settings">{{
            'shell.addProject' | transloco
          }}</a>
        </tc-state-block>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NeedsYouPage {
  protected readonly projects = inject(ProjectsStore);
}
