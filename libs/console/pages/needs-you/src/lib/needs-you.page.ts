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
import { NewTaskButton } from '@console/features/create-task';
import { InstallCard, InstallOffer } from '@console/features/install-app';
import { PushNudge } from '@console/features/push-subscribe';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, isPhoneSignal, Receipt, SrOnlyOnPhone, StateBlock, TopBarAction } from '@console/shared/ui';
import { QuestionList } from '@console/widgets/question-list';

/**
 * `/needs-you` (ADR 0001 decision 24, #16): every active project's waiting items, each tagged with its project and
 * answerable in place. With no registered project it is the shell's empty state and points to New project (#24).
 * While push is off on this device, the #36 nudge says so above the list, unless the install card (#761) has this
 * launch: one prompt per launch. "Approve team recommendations" (#220)
 * sits by the title on wider screens and above the list on the phone, where the title is for assistive tech only.
 */
@Component({
  selector: 'tc-needs-you-page',
  imports: [
    BatchApprove,
    Button,
    InstallCard,
    NewTaskButton,
    PushNudge,
    QuestionList,
    Receipt,
    RouterLink,
    SrOnlyOnPhone,
    StateBlock,
    TopBarAction,
    TranslocoPipe,
  ],
  template: `
    <div class="tc-page tc-page--cards needs-you">
      <div class="needs-you__head">
        <h1 #heading tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">
          {{ 'needsYou.title' | transloco }}
        </h1>
        @if (list(); as questions) {
          <tc-batch-approve [items]="questions.waitingItems()" (closed)="onBatch($event)" />
        }
        @if (!isPhone()) {
          <tc-new-task-button />
        } @else {
          <ng-template tcTopBarAction><tc-new-task-button compact /></ng-template>
        }
      </div>
      @if (batchDone(); as done) {
        <tc-receipt #batchReceipt data-testid="batch-receipt">
          <span tc-receipt-verb>{{ 'commands.batch.done' | transloco: { n: done } }}</span>
        </tc-receipt>
      }
      <tc-install-card [ready]="projects.status() === 'ready'" (dismissed)="focusHeading()" />
      @if (
        projects.status() === 'ready' &&
        projects.hasProjects() &&
        !installOffer.holdsPushNudgeOn(installOffer.screen())
      ) {
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
    /* #766: from 900 px the page takes the project space's padding and its one cap, so cards fill wide screens. */
    @media (min-width: 900px) {
      .needs-you {
        max-width: var(--page-max);
        padding-inline: var(--pad-x);
      }
    }

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
  protected readonly installOffer = inject(InstallOffer);
  private readonly injector = inject(Injector);
  /** New task (#107) is a button by the title on wider screens and `+` in the shell's top bar on the phone. */
  protected readonly isPhone = isPhoneSignal();
  protected readonly addProjectPath = ADD_PROJECT_PATH;
  protected readonly addProjectFragment = ADD_PROJECT_FRAGMENT;

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  protected readonly list = viewChild(QuestionList);
  private readonly batchReceipt = viewChild('batchReceipt', { read: ElementRef<HTMLElement> });
  /** How many the last batch approved; its receipt stays until the page is left. */
  protected readonly batchDone = signal<number | null>(null);

  /** The nudge or the install card went away by the owner's choice: keyboard users continue from the heading. */
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
