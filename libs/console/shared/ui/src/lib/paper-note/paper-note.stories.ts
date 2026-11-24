import { signal } from '@angular/core';
import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { PaperNote } from './paper-note';

const meta: Meta<PaperNote> = {
  title: 'Kit/PaperNote',
  component: PaperNote,
  decorators: [moduleMetadata({ imports: [PaperNote, TranslocoPipe] })],
  args: { leaving: false },
  render: (args) => ({
    props: args,
    template: `<tc-paper-note [leaving]="leaving">{{ 'stories.paperNote.text' | transloco }}</tc-paper-note>`,
  }),
};

export default meta;
type Story = StoryObj<PaperNote>;

export const Playground: Story = {};
/** The exit: up and out; `left` fires when it has played. */
export const Leaving: Story = { args: { leaving: true } };
/** The app's own use (#347): a note that leaves by itself after a moment. */
export const LeavesAfterAMoment: Story = {
  render: () => {
    const isLeaving = signal(false);
    setTimeout(() => isLeaving.set(true), 3000);
    return {
      props: { isLeaving },
      template: `<tc-paper-note [leaving]="isLeaving()">{{ 'stories.paperNote.text' | transloco }}</tc-paper-note>`,
    };
  },
};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
