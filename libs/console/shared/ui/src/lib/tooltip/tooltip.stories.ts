import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { componentWrapperDecorator, moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Icon } from '../icon/icon';
import { List, ListRow } from '../list/list';
import { Tooltip } from './tooltip';

/*
 * The board's use: a mark inside a row link. The name is hidden text in the link, the tooltip repeats it for the
 * mouse (hover the mark) and the keyboard (Tab to the row); Esc hides it. The phone shows nothing: no hover there.
 */
const mark = (placement: 'top' | 'start') => `
  <span style="position: relative; display: inline-flex; padding: var(--space-1); border-radius: var(--r-sm); background: var(--warning-soft); color: var(--warning-text)">
    <tc-icon name="tier-heavy" size="lg" />
    <span class="tc-sr-only">{{ 'stories.tooltip.tip' | transloco }}</span>
    <tc-tooltip placement="${placement}">{{ 'stories.tooltip.tip' | transloco }}</tc-tooltip>
  </span>
`;

/** "start" inside a list, which clips anything above its rows (the board). */
const row = `
  <tc-list [attr.aria-label]="'stories.tooltip.list' | transloco">
    <tc-list-row href="#row">
      <span tc-row-leading>#49</span>
      <span tc-row-title>{{ 'stories.tooltip.title' | transloco }}</span>
      <span tc-row-trailing>${mark('start')}</span>
    </tc-list-row>
  </tc-list>
`;

/** "top" where nothing clips above the mark. */
const inline = `
  <a href="#row" style="display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text)">
    {{ 'stories.tooltip.title' | transloco }} ${mark('top')}
  </a>
`;

const hover: Story['play'] = ({ canvasElement }) => {
  canvasElement
    .querySelector('tc-tooltip')
    ?.parentElement?.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
};

const focusRow: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLAnchorElement>('a')?.focus();
};

const meta: Meta<Tooltip> = {
  title: 'Kit/Tooltip',
  component: Tooltip,
  decorators: [
    moduleMetadata({ imports: [Tooltip, Icon, List, ListRow, TranslocoPipe] }),
    // Room above the row, so the "top" placement is not cut off by the canvas.
    componentWrapperDecorator((story) => `<div style="padding-top: var(--space-12)">${story}</div>`),
  ],
  render: () => ({ template: row }),
};

export default meta;
type Story = StoryObj<Tooltip>;

/** Beside the mark: inside a list, which clips anything above its first row. */
export const Start: Story = { play: hover };
export const Top: Story = { render: () => ({ template: inline }), play: hover };
/** Keyboard focus on the row shows it too; press Esc to hide it. */
export const KeyboardFocus: Story = { play: focusRow };
export const Dark: Story = { ...darkTheme, play: hover };
export const ReducedMotion: Story = { ...reducedMotion, play: hover };
/** Nothing to see on the phone: a tap opens the row, so the hidden name and the board's legend carry the meaning. */
export const Phone: Story = { ...phoneViewport };
