import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';
import { Banner } from './banner';

const both = `
  <div style="display: grid; gap: var(--space-4)">
    <div tc-banner tone="warning">
      <tc-icon tc-banner-icon name="pause" />
      <p tc-banner-text>{{ 'stories.banner.owner' | transloco }}</p>
      <div tc-banner-actions>
        <button tc-button size="sm" type="button">{{ 'stories.banner.resume' | transloco }}</button>
      </div>
    </div>
    <div tc-banner tone="danger">
      <tc-icon tc-banner-icon name="alert" />
      <p tc-banner-text>{{ 'stories.banner.team' | transloco }}</p>
      <div tc-banner-actions>
        <a href="#run-log">{{ 'stories.banner.log' | transloco }}</a>
        <button tc-button size="sm" type="button">{{ 'stories.banner.resume' | transloco }}</button>
      </div>
    </div>
  </div>
`;

const meta: Meta<Banner> = {
  title: 'Kit/Banner',
  component: Banner,
  decorators: [moduleMetadata({ imports: [Banner, Button, Icon, TranslocoPipe] })],
  argTypes: { tone: { control: 'select', options: ['warning', 'danger'] } },
  args: { tone: 'warning' },
  render: (args) => ({
    props: args,
    template: `
      <div tc-banner [tone]="tone">
        <tc-icon tc-banner-icon name="pause" />
        <p tc-banner-text>{{ 'stories.banner.owner' | transloco }}</p>
        <div tc-banner-actions>
          <button tc-button size="sm" type="button">{{ 'stories.banner.resume' | transloco }}</button>
        </div>
      </div>
    `,
  }),
};

export default meta;
type Story = StoryObj<Banner>;

export const Playground: Story = {};
export const Tones: Story = { render: () => ({ template: both }) };
export const Dark: Story = { ...darkTheme, render: () => ({ template: both }) };
export const ReducedMotion: Story = { ...reducedMotion, render: () => ({ template: both }) };
export const Phone: Story = { ...phoneViewport, render: () => ({ template: both }) };
