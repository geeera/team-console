import { provideRouter } from '@angular/router';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BoardJobsNone, type JobsNoneKind } from './board-jobs-none';
import { isolatedName } from './board-jobs';

interface Args {
  readonly kind: JobsNoneKind;
  readonly projectName: string;
  readonly runnerName: string;
}

const meta: Meta<Args> = {
  title: 'Widgets/Board jobs › No runner',
  decorators: [moduleMetadata({ imports: [BoardJobsNone] })],
  render: (args) => ({
    props: { ...args, projectName: isolatedName(args.projectName), runnerName: isolatedName(args.runnerName) },
    applicationConfig: { providers: [provideRouter([])] },
    template: `<tc-board-jobs-none [kind]="kind" [projectName]="projectName" [runnerName]="runnerName" />`,
  }),
  args: { kind: 'owner', projectName: 'team-console', runnerName: 'Mac' },
  argTypes: { kind: { control: 'select', options: ['owner', 'member', 'd3', 'd3-mine'] } },
};

export default meta;
type Story = StoryObj<Args>;

/** The owner: no runner of the account serves the project; the link opens Settings › Runners. */
export const Owner: Story = {};
/** A member: the generic copy, no action. Named owners wait for a display name (#775 follow-up). */
export const Member: Story = { args: { kind: 'member' } };
/** D3: another owner's subscription runner under «All account projects»; Connect a runner and «Why». */
export const OtherOwnersRunner: Story = { args: { kind: 'd3' } };
/** D3: the viewer's own subscription runner and another owner's project; the link to the runner and «Why». */
export const OwnRunner: Story = { args: { kind: 'd3-mine' } };
/** A right-to-left runner name stays isolated inside the sentence. */
export const RtlName: Story = { args: { kind: 'd3', runnerName: 'מק' } };
