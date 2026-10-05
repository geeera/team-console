import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { PushNudge } from '@console/features/push-subscribe';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, SrOnlyOnPhone, StateBlock } from '@console/shared/ui';
import { QuestionList } from '@console/widgets/question-list';

/**
 * `/needs-you` (ADR 0001 decision 24, #16): every active project's waiting items, each tagged with its project and
 * answerable in place. With no registered project it is the shell's empty state and points to New project (#24).
 * While push is off on this device, the #36 nudge says so above the list.
 */
@Component({
  selector: 'tc-needs-you-page',
  imports: [Button, PushNudge, QuestionList, RouterLink, SrOnlyOnPhone, StateBlock, TranslocoPipe],
  template: `
    <div class="tc-page">
      <h1 #heading tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">{{ 'needsYou.title' | transloco }}</h1>
      @if (projects.status() === 'ready' && projects.hasProjects()) {
        <tc-push-nudge (dismissed)="focusHeading()" />
      }
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
          <a tc-button tc-state-action variant="primary" routerLink="/settings/projects/new">{{
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

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  /** The nudge was hidden from its own button: keyboard users continue from the screen's heading. */
  protected focusHeading(): void {
    this.heading().nativeElement.focus();
  }
}
