import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { HomeScreenGuide } from './home-screen-guide';

const both = `
  <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-8); max-width: var(--log-max)">
    <tc-home-screen-guide [finalStep]="'install.guide.s3' | transloco: { app: 'Team Console' }" />
    <tc-home-screen-guide otherBrowser [finalStep]="'install.guide.s3' | transloco: { app: 'Team Console' }" />
  </div>
`;

const meta: Meta<HomeScreenGuide> = {
  title: 'Kit/HomeScreenGuide',
  component: HomeScreenGuide,
  decorators: [moduleMetadata({ imports: [HomeScreenGuide, TranslocoPipe] })],
  render: () => ({ template: both }),
};

export default meta;
type Story = StoryObj<HomeScreenGuide>;

/** Safari first, then Chrome, Edge or Firefox on iPhone (Share in the address bar). */
export const SafariAndOtherBrowsers: Story = {};
export const Dark: Story = { ...darkTheme };
export const Phone: Story = { ...phoneViewport };
