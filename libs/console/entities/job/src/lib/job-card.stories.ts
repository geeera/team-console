import type { JobDto, JobEventDto } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { JobCard } from './job-card';
import { jobEventFixture, jobFixture, queuedJobFixture } from './job.fixture';

interface Args {
  readonly job: JobDto;
  readonly runnerName: string;
  readonly events: readonly JobEventDto[];
  readonly eventsFailed: boolean;
}

const EVENTS: readonly JobEventDto[] = [
  jobEventFixture(1, { kind: 'started', payload: { skill: 'slot-dev' } }),
  jobEventFixture(2, { payload: { line: 'Picked TC-312: Run now on the board' } }),
  jobEventFixture(3, { level: 'warn', kind: 'notice', payload: { message: 'Lease renewed late' } }),
  jobEventFixture(4, { payload: { line: 'Opened PR #512' } }),
];

const meta: Meta<Args> = {
  title: 'Entities/Job card',
  decorators: [moduleMetadata({ imports: [JobCard] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: calc(var(--sidebar-w) * 2)">
        <tc-job-card [job]="job" [runnerName]="runnerName" [events]="events" [eventsFailed]="eventsFailed" />
      </div>
    `,
  }),
  args: { job: jobFixture(), runnerName: 'Mac mini', events: EVENTS, eventsFailed: false },
};

export default meta;
type Story = StoryObj<Args>;

/** Held by the owner's Mac, with the tail of its log (#464). */
export const Running: Story = {};
/** Claimed a moment ago: no events yet. */
export const JustClaimed: Story = {
  args: { job: jobFixture({ state: 'claimed', startedAt: null }), events: [] },
};
export const Queued: Story = {
  args: { job: queuedJobFixture({ kind: 'slot-qa' }), runnerName: '', events: [] },
};
export const Finished: Story = {
  args: {
    job: jobFixture({
      state: 'finished',
      finishedAt: '2026-11-11T09:40:00.000Z',
      result: { summary: 'Opened PR #512' },
    }),
    events: [],
  },
};
export const Failed: Story = {
  args: {
    job: jobFixture({
      state: 'failed',
      finishedAt: '2026-11-11T09:12:00.000Z',
      result: { summary: 'Tests failed' },
    }),
    events: [
      ...EVENTS,
      jobEventFixture(5, { level: 'error', kind: 'failed', payload: { summary: 'Tests failed' } }),
    ],
  },
};
/** A lease that lapsed twice: the Worker's reason stands in for a summary. */
export const Lost: Story = {
  args: {
    job: jobFixture({
      state: 'lost',
      attempt: 2,
      finishedAt: '2026-11-11T09:20:00.000Z',
      result: { reason: 'lost' },
    }),
    events: [],
  },
};
/** The last events read failed: the log shown may be behind. */
export const EventsStale: Story = { args: { eventsFailed: true } };
