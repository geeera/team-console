import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Callout } from './callout';

const tones = `
  <div style="display: grid; gap: var(--space-6); max-width: var(--log-max)">
    <section tc-callout tone="danger" aria-labelledby="callout-danger">
      <h2 tc-callout-title id="callout-danger">{{ 'stories.callout.refusedTitle' | transloco }}</h2>
      <p>{{ 'stories.callout.refusedBody' | transloco }}</p>
    </section>
    <section tc-callout tone="warning" aria-labelledby="callout-warning">
      <h2 tc-callout-title id="callout-warning">{{ 'stories.callout.leftTitle' | transloco }}</h2>
      <p>{{ 'stories.callout.leftBody' | transloco }}</p>
    </section>
    <section tc-callout tone="success" aria-labelledby="callout-success">
      <h2 tc-callout-title id="callout-success">{{ 'stories.callout.readyTitle' | transloco }}</h2>
    </section>
    <section tc-callout aria-labelledby="callout-neutral">
      <h2 tc-callout-title id="callout-neutral">{{ 'stories.callout.neutralTitle' | transloco }}</h2>
    </section>
  </div>
`;

const meta: Meta<Callout> = {
  title: 'Kit/Callout',
  component: Callout,
  decorators: [moduleMetadata({ imports: [Callout, TranslocoPipe] })],
  render: () => ({ template: tones }),
};

export default meta;
type Story = StoryObj<Callout>;

export const Tones: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
