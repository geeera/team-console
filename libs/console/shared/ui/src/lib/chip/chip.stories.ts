import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from './chip';

const allTones = `
  <div style="display: flex; flex-wrap: wrap; gap: var(--space-2)">
    <tc-chip>{{ 'stories.chip.draft' | transloco }}</tc-chip>
    <tc-chip tone="accent">{{ 'stories.chip.questions' | transloco }}</tc-chip>
    <tc-chip tone="success" dot>{{ 'stories.chip.active' | transloco }}</tc-chip>
    <tc-chip tone="warning" dot>{{ 'stories.chip.paused' | transloco }}</tc-chip>
    <tc-chip tone="danger" dot>{{ 'stories.chip.buildFailing' | transloco }}</tc-chip>
  </div>
`;

const meta: Meta<Chip> = {
  title: 'Kit/Chip',
  component: Chip,
  decorators: [moduleMetadata({ imports: [Chip, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['neutral', 'accent', 'success', 'warning', 'danger'] } },
  args: { tone: 'success', dot: true },
  render: (args) => ({
    props: args,
    template: `<tc-chip [tone]="tone" [dot]="dot">{{ 'stories.chip.active' | transloco }}</tc-chip>`,
  }),
};

export default meta;
type Story = StoryObj<Chip>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: allTones }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: allTones }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: allTones }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: allTones }) };

/**
 * A caller with no room to spare — the phone top bar's environment mark at 390 px (#470 item 1) — sets the
 * `--chip-px`/`--chip-fs` custom properties on an ancestor; no size input, since a custom property crosses a
 * component boundary that a tag or class selector cannot without `::ng-deep`.
 */
export const Compact: Story = {
  render: () => ({
    template: `
      <div style="display: flex; align-items: center; gap: var(--space-2)">
        <tc-chip>{{ 'stories.chip.draft' | transloco }}</tc-chip>
        <span style="--chip-px: var(--space-1); --chip-fs: var(--fs-2xs)">
          <tc-chip>{{ 'stories.chip.draft' | transloco }}</tc-chip>
        </span>
      </div>
    `,
  }),
};
