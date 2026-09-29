import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Chip } from '../chip/chip';
import { List, ListRow } from '../list/list';
import { Sheet } from './sheet';

@Component({
  selector: 'tc-story-projects-sheet',
  imports: [List, ListRow, Chip, Button, TranslocoPipe],
  template: `
    <tc-list plain [attr.aria-label]="'stories.list.ariaProjects' | transloco">
      <tc-list-row button current>
        <span tc-row-title>Team Console</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Sheltrix</span>
        <span tc-row-subtitle>{{ 'stories.sheet.paused' | transloco }}</span>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Reader</span>
      </tc-list-row>
    </tc-list>
    <div style="display: grid; gap: var(--space-2); margin-top: var(--space-4)">
      <button tc-button variant="primary" block type="button">{{ 'stories.sheet.addProject' | transloco }}</button>
      <button tc-button variant="quiet" block type="button">{{ 'stories.common.settings' | transloco }}</button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ProjectsSheetContent {}

@Component({
  selector: 'tc-story-sheet-host',
  imports: [Button, TranslocoPipe],
  template: `
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center">
      <button tc-button variant="primary" type="button" (click)="openProjects()">
        {{ 'stories.sheet.openSheet' | transloco }}
      </button>
      <button tc-button variant="danger" type="button" (click)="archive()">{{ 'stories.sheet.archiveEllipsis' | transloco }}</button>
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
