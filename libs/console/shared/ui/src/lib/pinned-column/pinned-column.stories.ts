import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme } from '../../../.storybook/stories';
import { PinnedColumn } from './pinned-column';

/*
 * A column pinned beside a long page, under a page header (#507): it ends at the bottom of the screen whether the
 * header is still in view or scrolled away, so its own scrollbar never runs under the edge. Scroll the canvas.
 */
const rows = (key: string): string =>
  `@for (row of rows; track row) {<p style="margin: 0; padding: var(--space-3) 0">{{ '${key}' | transloco }} {{ row }}</p>}`;

const page = `
  <header style="padding: var(--space-8) var(--space-4); border-bottom: var(--border-w) solid var(--border)">
    {{ 'stories.pinnedColumn.header' | transloco }}
  </header>
  <div style="display: flex; gap: var(--space-4); padding: 0 var(--space-4)">
    <div style="flex: 1">${rows('stories.pinnedColumn.page')}</div>
    <aside
      tcPinnedColumn
      style="position: sticky; top: 0; align-self: flex-start; width: var(--pane-w); display: flex;
        flex-direction: column; max-height: var(--tc-pinned-max-h, 100dvh); border-left: var(--border-w) solid var(--border)"
    >
      <div style="flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-4)">
        ${rows('stories.pinnedColumn.pane')}
      </div>
    </aside>
  </div>
`;

const meta: Meta<PinnedColumn> = {
  title: 'Kit/PinnedColumn',
  decorators: [moduleMetadata({ imports: [PinnedColumn, TranslocoPipe] })],
  render: () => ({ template: page, props: { rows: Array.from({ length: 40 }, (_, index) => index + 1) } }),
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<PinnedColumn>;

export const BesideALongPage: Story = {};
export const Dark: Story = { ...darkTheme };
