import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { SrOnlyOnPhone } from './sr-only-on-phone';

/*
 * A page heading the phone's top bar already shows: visible on wider screens, kept only for assistive tech on the
 * phone, so the first content moves up by the heading's height. Switch the viewport to see it go.
 */
const page = `
  <div class="tc-page">
    <h1 tcSrOnlyOnPhone class="tc-page__title" tabindex="-1">{{ 'stories.srOnlyOnPhone.title' | transloco }}</h1>
    <p style="margin: 0">{{ 'stories.srOnlyOnPhone.body' | transloco }}</p>
  </div>
`;

const meta: Meta<SrOnlyOnPhone> = {
  title: 'Kit/SrOnlyOnPhone',
  decorators: [moduleMetadata({ imports: [SrOnlyOnPhone, TranslocoPipe] })],
  render: () => ({ template: page }),
};

export default meta;
type Story = StoryObj<SrOnlyOnPhone>;

export const Wide: Story = {};
export const Dark: Story = { ...darkTheme };
/** The heading is gone from view but still the page's h1 for a screen reader. */
export const Phone: Story = { ...phoneViewport };
