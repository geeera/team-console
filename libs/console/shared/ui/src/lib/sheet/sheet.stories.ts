import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Chip } from '../chip/chip';
import { List, ListRow } from '../list/list';
import { Sheet } from './sheet';

@Component({
  selector: 'tc-story-projects-sheet',
  imports: [List, ListRow, Chip, Button],
  template: `
    <tc-list plain aria-label="Проекты">
      <tc-list-row button current>
        <span tc-row-title>Team Console</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Sheltrix</span>
        <span tc-row-subtitle>На паузе</span>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Reader</span>
      </tc-list-row>
    </tc-list>
    <div style="display: grid; gap: var(--space-2); margin-top: var(--space-4)">
      <button tc-button variant="primary" block type="button">Добавить проект</button>
      <button tc-button variant="quiet" block type="button">Настройки</button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ProjectsSheetContent {}

@Component({
  selector: 'tc-story-sheet-host',
  imports: [Button],
  template: `
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center">
      <button tc-button variant="primary" type="button" (click)="openProjects()">
        Открыть лист «Проекты»
      </button>
      <button tc-button variant="danger" type="button" (click)="archive()">В архив…</button>
      <span role="status" aria-live="polite">{{ result() }}</span>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class SheetHost {
  private readonly sheet = inject(Sheet);
  protected readonly result = signal('');

  protected openProjects(): void {
    this.sheet.open(ProjectsSheetContent, { title: 'Проекты' });
  }

  protected async archive(): Promise<void> {
    const confirmed = await this.sheet.confirm({
      title: 'Убрать проект в архив?',
      message: 'Проект исчезнет из списка и «Нужно твоё внимание». Задачи на GitHub не тронем.',
      confirmLabel: 'В архив',
      tone: 'danger',
    });
    this.result.set(confirmed ? 'Проект в архиве' : 'Оставили как есть');
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
