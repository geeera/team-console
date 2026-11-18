import { provideRouter } from '@angular/router';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BoardJobsNone, type JobsNoneKind } from './board-jobs-none';
import { isolatedName } from './board-jobs';

interface Args {
  readonly kind: JobsNoneKind;
  readonly projectName: string;
  readonly runnerName: string;
  /** Who the copy names; empty for the nameless copy (no display name yet). */
  readonly people: string;
}

const meta: Meta<Args> = {
  title: 'Widgets/Board jobs › No runner',
  decorators: [moduleMetadata({ imports: [BoardJobsNone] })],
  render: (args) => ({
    props: {
      ...args,
      projectName: isolatedName(args.projectName),
      runnerName: isolatedName(args.runnerName),
      people: args.people === '' ? '' : args.people.split(', ').map(isolatedName).join(', '),
    },
    applicationConfig: { providers: [provideRouter([])] },
    template: `<tc-board-jobs-none [kind]="kind" [projectName]="projectName" [runnerName]="runnerName" [people]="people" />`,
  }),
  args: { kind: 'owner', projectName: 'team-console', runnerName: 'Mac', people: '' },
  argTypes: { kind: { control: 'select', options: ['owner', 'member', 'd3', 'd3-mine'] } },
};

export default meta;
type Story = StoryObj<Args>;

/** The owner: no runner of the account serves the project; the link opens Settings › Runners. */
export const Owner: Story = {};
/** A member: the generic copy, no action; no owner has a display name yet. */
export const Member: Story = { args: { kind: 'member' } };
/** A member, with the owners' display names. */
export const MemberNamed: Story = { args: { kind: 'member', people: 'Анна, Борис' } };
/** D3: another owner's subscription runner under «All account projects»; Connect a runner and «Why». */
export const OtherOwnersRunner: Story = { args: { kind: 'd3' } };
/** The same, naming the runner's owner. */
export const OtherOwnersRunnerNamed: Story = { args: { kind: 'd3', people: 'Анна' } };
/** D3: the viewer's own subscription runner and another owner's project; the link to the runner and «Why». */
export const OwnRunner: Story = { args: { kind: 'd3-mine' } };
/** The same, naming the project's creator. */
export const OwnRunnerNamed: Story = { args: { kind: 'd3-mine', people: 'Борис' } };
/** A right-to-left runner name stays isolated inside the sentence. */
export const RtlName: Story = { args: { kind: 'd3', runnerName: 'מק' } };
