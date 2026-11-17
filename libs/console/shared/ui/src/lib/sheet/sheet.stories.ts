import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { provideRouter } from '@angular/router';
import type { Meta, StoryObj } from '@storybook/angular';
import { applicationConfig, moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Choice, ChoiceGroup } from '../choice/choice';
import { Chip } from '../chip/chip';
import { Field, FieldControl } from '../field/field';
import { Segment, SegmentedRadio } from '../segmented/segmented';
import { List, ListRow } from '../list/list';
import { DialogRef } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
import { BREAKPOINTS } from '../../tokens/breakpoints';
import { ConfirmFailure } from './confirm-dialog';
import { Sheet } from './sheet';
import { SheetFooter } from './sheet-footer';

@Component({
  selector: 'tc-story-projects-sheet',
  imports: [List, ListRow, Chip, Button, TranslocoPipe],
  template: `
    <tc-list plain [attr.aria-label]="'stories.list.ariaProjects' | transloco">
      <tc-list-row button current>
        <span tc-row-title>{{ projects[0] }}</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>{{ projects[1] }}</span>
        <span tc-row-subtitle>{{ 'stories.sheet.paused' | transloco }}</span>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>{{ projects[2] }}</span>
      </tc-list-row>
    </tc-list>
    <div style="display: grid; gap: var(--space-2); margin-top: var(--space-4)">
      <button tc-button variant="primary" block type="button">
        {{ 'stories.sheet.addProject' | transloco }}
      </button>
      <button tc-button variant="quiet" block type="button">
        {{ 'stories.common.settings' | transloco }}
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ProjectsSheetContent {
  /** Project names are data, not copy: the same in every language. */
  protected readonly projects = ['Team Console', 'Sheltrix', 'Reader'] as const;
}

/** #194: a body long enough to scroll (the body becomes a focusable region) and actions in the footer slot. */
@Component({
  selector: 'tc-story-footer-sheet',
  imports: [Button, SheetFooter, TranslocoPipe],
  template: `
    @for (paragraph of paragraphs; track paragraph) {
      <p>{{ 'stories.sheet.footerBody' | transloco }}</p>
    }
    <ng-template tcSheetFooter="primary">
      <button tc-button variant="primary" type="button" (click)="ref.close()">
        {{ 'stories.sheet.footerDone' | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">
        {{ 'stories.sheet.footerSecondary' | transloco }}
      </button>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class FooterSheetContent {
  protected readonly ref = inject(DialogRef);
  protected readonly paragraphs = [1, 2, 3, 4, 5, 6, 7, 8] as const;
}

/**
 * #274: the shell with a form taller than the screen («Попросить PM»). The frame fits the visual viewport; the title
 * and the footer stay in view and only the body scrolls. The submit button lives in the footer, outside the form,
 * so it names the form with `form`.
 */
@Component({
  selector: 'tc-story-long-form-sheet',
  imports: [Button, Choice, ChoiceGroup, SheetFooter, TranslocoPipe],
  template: `
    <form id="tc-story-long-form" style="display: grid; gap: var(--space-4)" (submit)="send($event)">
      <p style="margin: 0">{{ 'stories.sheet.longIntro' | transloco }}</p>
      @for (group of groups; track group) {
        <fieldset tc-choice-group [legend]="'stories.sheet.longSprint' | transloco">
          @for (option of options; track option) {
            <label tc-choice>
              <input
                type="radio"
                [name]="'story-sprint-' + group"
                [value]="option"
                [checked]="option === 'longCurrent'"
              />
              {{ 'stories.sheet.' + option | transloco }}
            </label>
          }
        </fieldset>
        <p style="margin: 0; color: var(--text-2); font-size: var(--fs-sm)">
          {{ 'stories.sheet.longHint' | transloco }}
        </p>
      }
    </form>
    <ng-template tcSheetFooter="primary">
      <button tc-button variant="primary" type="submit" form="tc-story-long-form">
        {{ 'stories.sheet.longSend' | transloco }}
      </button>
    </ng-template>
    <ng-template tcSheetFooter="secondary">
      <button tc-button type="button" (click)="ref.close()">{{ 'ui.confirm.cancel' | transloco }}</button>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class LongFormSheetContent {
  protected readonly ref = inject(DialogRef);
  protected readonly groups = [1, 2, 3] as const;
  protected readonly options = ['longCurrent', 'longNext', 'longBacklog'] as const;

  protected send(event: Event): void {
    event.preventDefault();
    this.ref.close('sent');
  }
}

/**
 * #277: `size: 'full'` — the frame fills the screen (phone) or the large dialog (Mac); the body does not scroll, the
 * content lays out as a column and owns the one scroller (here a stage of tall placeholder blocks under a toolbar).
 */
@Component({
  selector: 'tc-story-full-sheet',
  imports: [Button, SheetFooter, TranslocoPipe],
  template: `
    <div style="display: flex; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-bottom: var(--border-w) solid var(--border)">
      <button tc-button size="sm" type="button" aria-pressed="true">{{ 'stories.sheet.fullToolbarA' | transloco }}</button>
      <button tc-button size="sm" type="button" aria-pressed="false">{{ 'stories.sheet.fullToolbarB' | transloco }}</button>
    </div>
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-4); display: grid; gap: var(--space-3)">
      @for (block of blocks; track block) {
        <div style="height: var(--stamp-size); border-radius: var(--r-md); background: var(--skeleton)"></div>
      }
    </div>
    <ng-template tcSheetFooter="primary">
      <button tc-button variant="primary" type="button" (click)="ref.close()">
        {{ 'stories.sheet.footerDone' | transloco }}
      </button>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class FullSheetContent {
  protected readonly ref = inject(DialogRef);
  protected readonly blocks = Array.from({ length: 12 }, (_, index) => index);
}

/**
 * #107's New task form in the kit's pieces: on the phone Create sits in the head (`headAction`) above the keyboard and
 * the subtitle says where it goes; on the Mac it is a `task`-wide dialog with Create in the footer.
 */
@Component({
  selector: 'tc-story-task-sheet',
  imports: [
    Button,
    Choice,
    ChoiceGroup,
    Chip,
    Field,
    FieldControl,
    Segment,
    SegmentedRadio,
    SheetFooter,
    TranslocoPipe,
  ],
  template: `
    <form id="tc-story-task-form" style="display: grid; gap: var(--space-5)" (submit)="send($event)">
      <tc-field
        required
        [label]="'stories.sheet.taskName' | transloco"
        [hint]="'stories.sheet.taskNameHint' | transloco"
      >
        <input tcInput type="text" autocomplete="off" />
      </tc-field>
      <fieldset tc-segmented [legend]="'stories.segmented.kind' | transloco">
        @for (kind of kinds; track kind) {
          <label tc-segment>
            <input type="radio" name="story-task-kind" [value]="kind" [checked]="kind === 'feature'" />
            {{ 'stories.segmented.' + kind | transloco }}
          </label>
        }
        <p tc-segmented-hint>{{ 'stories.segmented.featureHint' | transloco }}</p>
      </fieldset>
      <fieldset tc-choice-group [legend]="'stories.choice.sprint' | transloco">
        <label tc-choice off>
          <input
            type="radio"
            name="story-task-sprint"
            value="current"
            aria-describedby="story-task-current"
          />
          <span
            >{{ 'stories.choice.current' | transloco }}
            <tc-chip>{{ 'stories.choice.frozen' | transloco }}</tc-chip></span
          >
          <small tc-choice-hint id="story-task-current">{{ 'stories.choice.currentOff' | transloco }}</small>
        </label>
        <label tc-choice>
          <input
            type="radio"
            name="story-task-sprint"
            value="next"
            checked
            aria-describedby="story-task-next"
          />
          {{ 'stories.choice.next' | transloco }}
          <small tc-choice-hint id="story-task-next">{{ 'stories.choice.nextHint' | transloco }}</small>
        </label>
        <label tc-choice>
          <input
            type="radio"
            name="story-task-sprint"
            value="backlog"
            aria-describedby="story-task-backlog"
          />
          {{ 'stories.choice.backlog' | transloco }}
          <small tc-choice-hint id="story-task-backlog">{{ 'stories.choice.backlogHint' | transloco }}</small>
        </label>
      </fieldset>
    </form>
    <ng-template tcSheetFooter="primary">
      <button tc-button variant="primary" type="submit" form="tc-story-task-form">
        {{
          (isPhone ? 'stories.sheet.taskCreate' : 'stories.sheet.taskCreateIn')
            | transloco: { project: project }
        }}
      </button>
    </ng-template>
    <!-- On the phone Close is already in the head. -->
    @if (!isPhone) {
      <ng-template tcSheetFooter="secondary">
        <button tc-button type="button" (click)="ref.close()">{{ 'ui.close' | transloco }}</button>
      </ng-template>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class TaskSheetContent {
  protected readonly ref = inject(DialogRef);
  protected readonly isPhone = inject(BreakpointObserver).isMatched(BREAKPOINTS.phone);
  /** A project slug is data, not copy. */
  protected readonly project = 'team-console';
  protected readonly kinds = ['feature', 'bug', 'chore'] as const;

  protected send(event: Event): void {
    event.preventDefault();
    this.ref.close('sent');
  }
}

@Component({
  selector: 'tc-story-task-sheet-host',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class TaskSheetHost {
  constructor() {
    const sheet = inject(Sheet);
    const transloco = inject(TranslocoService);
    afterNextRender(() =>
      sheet.open(TaskSheetContent, {
        title: transloco.translate('stories.sheet.taskTitle'),
        subtitle: transloco.translate('stories.sheet.taskSubtitle', { project: 'team-console' }),
        headAction: true,
        width: 'task',
      }),
    );
  }
}

@Component({
  selector: 'tc-story-full-sheet-host',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class FullSheetHost {
  constructor() {
    const sheet = inject(Sheet);
    const transloco = inject(TranslocoService);
    afterNextRender(() =>
      sheet.open(FullSheetContent, { title: transloco.translate('stories.sheet.fullTitle'), size: 'full' }),
    );
  }
}

/** Opens the long form as soon as the story renders, so the story shows the shell itself. */
@Component({
  selector: 'tc-story-long-form-host',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class LongFormHost {
  constructor() {
    const sheet = inject(Sheet);
    const transloco = inject(TranslocoService);
    afterNextRender(() => openLongForm(sheet, transloco));
  }
}

function openLongForm(sheet: Sheet, transloco: TranslocoService): void {
  sheet.open(LongFormSheetContent, { title: transloco.translate('stories.sheet.longTitle') });
}

@Component({
  selector: 'tc-story-sheet-host',
  imports: [Button, TranslocoPipe],
  template: `
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center">
      <button tc-button variant="primary" type="button" (click)="openProjects()">
        {{ 'stories.sheet.openSheet' | transloco }}
      </button>
      <button tc-button variant="danger" type="button" (click)="archive()">
        {{ 'stories.sheet.archiveEllipsis' | transloco }}
      </button>
      <button tc-button type="button" (click)="archiveFailing()">
        {{ 'stories.sheet.archiveFailing' | transloco }}
      </button>
      <button tc-button type="button" (click)="pause()">
        {{ 'stories.sheet.pauseEllipsis' | transloco }}
      </button>
      <button tc-button type="button" (click)="openWithFooter()">
        {{ 'stories.sheet.openFooter' | transloco }}
      </button>
      <button tc-button type="button" (click)="openLongForm()">
        {{ 'stories.sheet.longEllipsis' | transloco }}
      </button>
      <button tc-button type="button" (click)="runNotConfigured()">
        {{ 'stories.sheet.runOpen' | transloco }}
      </button>
      <button tc-button type="button" (click)="moveDate()">
        {{ 'stories.sheet.dateEllipsis' | transloco }}
      </button>
      <span role="status" aria-live="polite">{{ result() }}</span>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class SheetHost {
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  protected readonly result = signal('');

  protected openProjects(): void {
    this.sheet.open(ProjectsSheetContent, { title: this.transloco.translate('stories.list.ariaProjects') });
  }

  protected openWithFooter(): void {
    this.sheet.open(FooterSheetContent, {
      title: this.transloco.translate('stories.sheet.footerTitle', { repo: 'geeera/storify' }),
      width: 'wide',
    });
  }

  protected openLongForm(): void {
    openLongForm(this.sheet, this.transloco);
  }

  protected async archive(): Promise<void> {
    const confirmed = await this.sheet.confirm({
      title: this.transloco.translate('stories.sheet.confirmTitle'),
      message: this.transloco.translate('stories.sheet.confirmMessage'),
      confirmLabel: this.transloco.translate('stories.button.archive'),
      tone: 'danger',
    });
    this.result.set(
      this.transloco.translate(confirmed ? 'stories.sheet.confirmedArchived' : 'stories.sheet.confirmedKept'),
    );
  }

  /** The busy and failure states of a confirm with an action: Archiving… for a moment, then the inline alert. */
  protected async archiveFailing(): Promise<void> {
    const confirmed = await this.sheet.confirm({
      title: this.transloco.translate('stories.sheet.confirmTitle'),
      message: this.transloco.translate('stories.sheet.confirmMessage'),
      note: this.transloco.translate('stories.sheet.note'),
      confirmLabel: this.transloco.translate('stories.button.archive'),
      busyLabel: this.transloco.translate('stories.sheet.busy'),
      errorMessage: this.transloco.translate('stories.sheet.error'),
      tone: 'danger',
      action: async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        throw new Error('story: the archive request failed');
      },
    });
    this.result.set(
      this.transloco.translate(confirmed ? 'stories.sheet.confirmedArchived' : 'stories.sheet.confirmedKept'),
    );
  }

  /**
   * #114's command confirmation: points, an optional reason, Sending…, then a refusal in the owner's words that
   * keeps the dialog open with Try again; the second press succeeds.
   */
  protected async pause(): Promise<void> {
    let attempts = 0;
    const t = (key: string): string => this.transloco.translate(key);
    const confirmed = await this.sheet.confirm({
      title: t('stories.sheet.pauseTitle'),
      message: '',
      items: [t('stories.sheet.pausePoint1'), t('stories.sheet.pausePoint2')],
      input: { label: t('stories.sheet.reasonLabel'), hint: t('stories.sheet.reasonHint'), maxLength: 300 },
      confirmLabel: t('stories.sheet.pauseOk'),
      busyLabel: t('stories.sheet.sending'),
      action: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (attempts === 1) {
          throw new ConfirmFailure(t('stories.sheet.rateLimited'));
        }
      },
    });
    this.result.set(t(confirmed ? 'stories.sheet.paused' : 'stories.sheet.confirmedKept'));
  }

  /** #750: a refusal with its way out — the link closes every sheet and opens the screen that fixes it. */
  protected async runNotConfigured(): Promise<void> {
    const t = (key: string): string => this.transloco.translate(key);
    const confirmed = await this.sheet.confirm({
      title: t('stories.sheet.runTitle'),
      message: t('stories.sheet.runMessage'),
      busyLabel: t('stories.sheet.sending'),
      action: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        throw new ConfirmFailure(t('stories.sheet.runNotConfigured'), undefined, {
          label: t('stories.sheet.runSetLink'),
          route: ['/'],
        });
      },
    });
    this.result.set(t(confirmed ? 'stories.sheet.paused' : 'stories.sheet.confirmedKept'));
  }

  /**
   * #218's date confirmation: the native picker, a hint that follows the date, a refusal under the field that holds
   * Confirm, an ochre caution, and a conflict that refills the field with the live value.
   */
  protected async moveDate(): Promise<void> {
    let attempts = 0;
    const t = (key: string, params?: Record<string, unknown>): string => this.transloco.translate(key, params);
    const today = new Date().toISOString().slice(0, 10);
    const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const current = inDays(9);
    const confirmed = await this.sheet.confirm({
      title: t('stories.sheet.dateTitle'),
      message: t('stories.sheet.dateMessage', { date: current }),
      input: {
        label: t('stories.sheet.dateLabel'),
        type: 'date',
        value: current,
        min: today,
        check: (value) => {
          if (value === '' || value < today) {
            return { error: t('stories.sheet.datePast') };
          }
          if (value === current) {
            return { confirmLabel: t('stories.sheet.dateSame'), isBlocked: true };
          }
          return {
            hint: t('stories.sheet.dateHint', { date: value }),
            confirmLabel: t('stories.sheet.dateOk', { date: value }),
            ...(value <= inDays(2) ? { warning: t('stories.sheet.dateWarning') } : {}),
          };
        },
      },
      busyLabel: t('stories.sheet.sending'),
      action: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (attempts === 1) {
          throw new ConfirmFailure(t('stories.sheet.dateConflict', { date: inDays(10) }), inDays(10));
        }
      },
    });
    this.result.set(t(confirmed ? 'stories.sheet.dateDone' : 'stories.sheet.confirmedKept'));
  }
}

const meta: Meta<SheetHost> = {
  title: 'Kit/Sheet',
  component: SheetHost,
  // The confirmation's failure link (#750) is a router link.
  decorators: [applicationConfig({ providers: [provideRouter([])] }), moduleMetadata({ imports: [SheetHost] })],
  // The sheet renders in the CDK overlay container, outside the story root; axe must see both.
  parameters: { a11y: { context: 'body' } },
  render: () => ({ template: '<tc-story-sheet-host />' }),
};

export default meta;
type Story = StoryObj<SheetHost>;

export const Default: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };

/** #274: the one dialog shell with a form taller than the screen — title and actions stay, only the body scrolls. */
const longForm: Story = {
  decorators: [moduleMetadata({ imports: [LongFormHost] })],
  render: () => ({ template: '<tc-story-long-form-host />' }),
};
export const LongForm: Story = { ...longForm };
export const LongFormPhone: Story = { ...longForm, ...phoneViewport };

/** #277: the full-size shell of the design viewer — the large dialog on the Mac, the whole screen on the phone. */
const full: Story = {
  decorators: [moduleMetadata({ imports: [FullSheetHost] })],
  render: () => ({ template: '<tc-story-full-sheet-host />' }),
};
export const Full: Story = { ...full };
export const FullPhone: Story = { ...full, ...phoneViewport };

/** #107: New task — Create in the head on the phone, a `task`-wide dialog with Create in the footer on the Mac. */
const task: Story = {
  decorators: [moduleMetadata({ imports: [TaskSheetHost] })],
  render: () => ({ template: '<tc-story-task-sheet-host />' }),
};
export const HeadAction: Story = { ...task };
export const HeadActionPhone: Story = { ...task, ...phoneViewport };
export const HeadActionPhoneDark: Story = {
  ...task,
  globals: { ...phoneViewport.globals, ...darkTheme.globals },
};
