import type { SprintRun, SprintTeam } from '@console/entities/sprint';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BoardRunLog } from './board-run-log';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const dark = { globals: { theme: 'dark' } };
const reduced = { globals: { motion: 'reduce' } };
const phone = { globals: { viewport: { value: 'iphone', isRotated: false } } };

const AT = '2026-11-20T08:00:00Z';
const run = (state: SprintRun['state'], slotName: string): SprintRun => ({ slot: null, slotName, state, at: AT });

const RUNS: readonly SprintRun[] = [
  run('running', 'Morning'),
  run('finished', 'Night'),
  run('finished', 'Evening'),
  run('failed', 'Afternoon'),
  run('finished', 'Morning'),
];

const team = (state: SprintTeam['state'], recentRuns: readonly SprintRun[]): SprintTeam => ({
  state,
  runLogUrl: 'https://github.com/o/r/issues/1',
  recentRuns,
});

const meta: Meta<BoardRunLog> = {
  title: 'Widgets/Board run log',
  component: BoardRunLog,
  decorators: [moduleMetadata({ imports: [BoardRunLog] })],
  render: (args) => ({ props: args, template: `<tc-board-run-log [team]="team" />` }),
  args: { team: team('running', RUNS) },
};

export default meta;
type Story = StoryObj<BoardRunLog>;

/** The team is working: the accent dot breathes beside the state, and the five latest runs are stamps (filled, hollow, reddish). */
export const Working: Story = {};
/** Not working: the stamps stay, the dot is gone. */
export const Paused: Story = { args: { team: team('paused', RUNS.slice(1)) } };
export const Failing: Story = { args: { team: team('failing', [run('failed', 'Morning'), ...RUNS.slice(1, 3)]) } };
export const Dark: Story = dark;
/** Reduced motion: the dot stays still. */
export const ReducedMotion: Story = reduced;
export const Phone: Story = phone;
