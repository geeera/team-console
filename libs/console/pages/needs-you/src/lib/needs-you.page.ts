import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, StateBlock } from '@console/shared/ui';

/**
 * `/needs-you` (ADR 0001 decision 24) until #16 fills it. With no registered project it is the
 * shell's empty state and points to Settings, where a project gets added (#24).
 */
@Component({
  selector: 'tc-needs-you-page',
  imports: [Button, RouterLink, StateBlock, TranslocoPipe],
  template: `
    <div class="tc-page">
      <h1 class="tc-page__title">{{ 'needsYou.title' | transloco }}</h1>
      @if (projects.status() !== 'ready') {
        <tc-state-block kind="loading" [title]="'shell.loading' | transloco" />
      } @else if (projects.hasProjects()) {
        <tc-state-block
          kind="empty"
          [title]="'needsYou.emptyTitle' | transloco"
          [description]="'needsYou.emptyHint' | transloco"
        />
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
