import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport } from '../../../.storybook/stories';
import { Frame } from './frame';

// The published Storybook frames one of its own stories; a local run (http://localhost) shows it as a link instead.
const STORYBOOK = 'https://team-console-storybook.pages.dev';

const meta: Meta<Frame> = {
  title: 'Kit/Frame',
  component: Frame,
  decorators: [moduleMetadata({ imports: [Frame, TranslocoPipe] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: var(--log-max)">
        <tc-frame [src]="src" [allowedOrigins]="allowedOrigins" [title]="'stories.frame.title' | transloco" />
      </div>
    `,
  }),
  args: {
    src: `${STORYBOOK}/iframe.html?id=kit-callout--tones&viewMode=story`,
    allowedOrigins: [STORYBOOK],
  },
};

export default meta;
type Story = StoryObj<Frame>;

export const Embedded: Story = {};
/** #277: the design profile — `sandbox="allow-scripts"` alone — for an HTML wireframe from GitHub Pages. */
export const DesignProfile: Story = { args: { profile: 'design' } };
/** Not on the allow-list (another project on the same platform): a note and a link, never a frame. */
export const NotEmbeddable: Story = { args: { src: 'https://another-project.pages.dev/', allowedOrigins: [STORYBOOK] } };
/** A loopback address is never framed, even when listed. */
export const Loopback: Story = { args: { src: 'https://127.0.0.1/', allowedOrigins: ['https://127.0.0.1'] } };
export const Dark: Story = { ...darkTheme, args: { src: 'https://another-project.pages.dev/', allowedOrigins: [] } };
export const Phone: Story = { ...phoneViewport };
