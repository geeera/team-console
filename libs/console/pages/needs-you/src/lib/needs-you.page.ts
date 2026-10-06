import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ADD_PROJECT_FRAGMENT, ADD_PROJECT_PATH, ProjectsStore } from '@console/entities/project';
import { BatchApprove, type BatchApproved } from '@console/features/batch-approve';
import { PushNudge } from '@console/features/push-subscribe';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Receipt, SrOnlyOnPhone, StateBlock } from '@console/shared/ui';
import { QuestionList } from '@console/widgets/question-list';

/**
 * `/needs-you` (ADR 0001 decision 24, #16): every active project's waiting items, each tagged with its project and
 * answerable in place. With no registered project it is the shell's empty state and points to New project (#24).
 * While push is off on this device, the #36 nudge says so above the list. "Approve team recommendations" (#220)
 * sits by the title on wider screens and above the list on the phone, where the title is for assistive tech only.
 */
@Component({
  selector: 'tc-needs-you-page',
  imports: [
    BatchApprove,
    Button,
    PushNudge,
    QuestionList,
    Receipt,
    RouterLink,
    SrOnlyOnPhone,
    StateBlock,
    TranslocoPipe,
  ],
  template: `
    <div class="tc-page">
      <div class="needs-you__head">
        <h1 #heading tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">
          {{ 'needsYou.title' | transloco }}
        </h1>
        @if (list(); as questions) {
          <tc-batch-approve [items]="questions.waitingItems()" (closed)="onBatch($event)" />
        }
      </div>
      @if (batchDone(); as done) {
        <tc-receipt #batchReceipt data-testid="batch-receipt">
          <span tc-receipt-verb>{{ 'commands.batch.done' | transloco: { n: done } }}</span>
        </tc-receipt>
      }
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
          <a
            tc-button
            tc-state-action
            variant="primary"
            [routerLink]="addProjectPath"
            [fragment]="addProjectFragment"
            >{{ 'shell.addProject' | transloco }}</a
          >
        </tc-state-block>
      }
    </div>
  `,
  styles: `
    .needs-you__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NeedsYouPage {
  protected readonly projects = inject(ProjectsStore);
  private readonly injector = inject(Injector);
  protected readonly addProjectPath = ADD_PROJECT_PATH;
  protected readonly addProjectFragment = ADD_PROJECT_FRAGMENT;

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  protected readonly list = viewChild(QuestionList);
  private readonly batchReceipt = viewChild('batchReceipt', { read: ElementRef<HTMLElement> });
  /** How many the last batch approved; its receipt stays until the page is left. */
  protected readonly batchDone = signal<number | null>(null);

  /** The nudge was hidden from its own button: keyboard users continue from the screen's heading. */
  protected focusHeading(): void {
    this.heading().nativeElement.focus();
  }

  /** The approved cards have left the list; focus goes to the receipt that says so, not to the page. */
  protected onBatch(result: BatchApproved): void {
    if (result.approved.length > 0) {
      this.batchDone.set((this.batchDone() ?? 0) + result.approved.length);
      afterNextRender(() => this.batchReceipt()?.nativeElement.focus(), { injector: this.injector });
    }
    if (result.hasChanged) {
      void this.list()?.reload();
    }
  }
}
