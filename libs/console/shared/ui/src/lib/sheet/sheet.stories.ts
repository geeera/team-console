import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Chip } from '../chip/chip';
import { List, ListRow } from '../list/list';
import { DialogRef } from '@angular/cdk/dialog';
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
    <ng-template tcSheetFooter>
      <button tc-button variant="primary" type="button" (click)="ref.close()">
        {{ 'stories.sheet.footerDone' | transloco }}
      </button>
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
}

const meta: Meta<SheetHost> = {
  title: 'Kit/Sheet',
  component: SheetHost,
  decorators: [moduleMetadata({ imports: [SheetHost] })],
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
