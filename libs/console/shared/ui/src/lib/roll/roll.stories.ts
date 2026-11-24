import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Stat, Stats } from '../stat/stat';
import { Roll } from './roll';

const counter = `
  <div style="display: flex; gap: var(--space-3); align-items: center">
    <span style="font-size: var(--fs-xl); font-weight: var(--fw-semibold)"><tc-roll [value]="value" /></span>
    <button tc-button size="sm" type="button" (click)="value = value + 1">{{ 'stories.roll.next' | transloco }}</button>
  </div>
`;

/** The same primitive behind a board tile: the value is text, so a phrase rolls as one piece. */
const tile = `
  <dl tc-stats [columns]="2">
    <div tc-stat [label]="'stories.roll.label' | transloco" [rollingValue]="'' + value"></div>
  </dl>
  <button tc-button size="sm" type="button" (click)="value = value + 1">{{ 'stories.roll.next' | transloco }}</button>
`;

const meta: Meta<Roll> = {
  title: 'Kit/Roll',
  component: Roll,
  decorators: [moduleMetadata({ imports: [Button, Roll, Stat, Stats, TranslocoPipe] })],
  render: () => ({ props: { value: 3 }, template: counter }),
};

export default meta;
type Story = StoryObj<Roll>;

/** Press the button: the old number leaves upward and the new one comes up from below. */
export const Playground: Story = {};
export const Dark: Story = { ...darkTheme };
/** Reduced motion: the number changes at once. */
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
export const InATile: Story = { render: () => ({ props: { value: 2 }, template: tile }) };
