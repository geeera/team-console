import {
  idleOrchestrationFixture,
  OrchestrationApi,
  runningOrchestrationFixture,
  type OrchestrationFailureKind,
  type OrchestrationResult,
} from '@console/entities/orchestration';
import type { OrchestrationDto, RunnerAvailability } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { OrchestrationControls } from './orchestration-controls';

type Answer = OrchestrationResult<OrchestrationDto>;

/** What the fake Worker answers: the run read, then Start and Stop; `pending` never answers. */
interface Answers {
  readonly read: Answer | 'pending';
  readonly start?: Answer | 'pending';
  readonly stop?: Answer | 'pending';
}

interface Args {
  readonly availability: RunnerAvailability | null;
}

const ok = (value: OrchestrationDto): Answer => ({ ok: true, value });
const refused = (kind: OrchestrationFailureKind, slug: string | null = null): Answer => ({
  ok: false,
  failure: { kind, slug },
});

const answer = async (value: Answer | 'pending' | undefined, fallback: Answer): Promise<Answer> =>
  value === 'pending' ? new Promise<Answer>(() => undefined) : (value ?? fallback);

/** The controls over a fake `OrchestrationApi`: no request leaves Storybook. */
function withAnswers(answers: Answers) {
  return applicationConfig({
    providers: [
      {
        provide: OrchestrationApi,
        useValue: {
          get: async () => answer(answers.read, ok(idleOrchestrationFixture())),
          start: async () => answer(answers.start, ok(runningOrchestrationFixture())),
          stop: async () => answer(answers.stop, ok(idleOrchestrationFixture())),
        },
      },
    ],
  });
}

const meta: Meta<Args> = {
  title: 'Features/Orchestration controls',
  decorators: [moduleMetadata({ imports: [OrchestrationControls] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: calc(var(--card-min-w) * 2)">
        <tc-orchestration-controls slug="team-console" [availability]="availability" />
      </div>
    `,
  }),
  args: { availability: 'ready' },
  argTypes: {
    availability: { control: 'select', options: ['ready', 'offline', 'paused', 'team-paused', 'none', null] },
  },
};

export default meta;
type Story = StoryObj<Args>;

/** No run: «Запустить команду». Pressing it starts one (the fake answers a run on its first step). */
export const Idle: Story = { decorators: [withAnswers({ read: ok(idleOrchestrationFixture()) })] };

/** A run on its third step: «Остановить», which asks first. */
export const Running: Story = {
  decorators: [withAnswers({ read: ok(runningOrchestrationFixture({ steps: 3 })) })],
};

/** The last step finished with `next: owner`: still on, so still Stop. */
export const WaitingForOwner: Story = {
  decorators: [
    withAnswers({
      read: ok(runningOrchestrationFixture({ state: 'waiting-owner', liveStepId: null, steps: 4 })),
    }),
  ],
};

/** No runner serves the project: Start stays readable and focusable, held back with the reason under it. */
export const NoRunner: Story = {
  args: { availability: 'none' },
  decorators: [withAnswers({ read: ok(idleOrchestrationFixture()) })],
};

/** The first read is on its way: the button waits with its spinner. */
export const Loading: Story = { decorators: [withAnswers({ read: 'pending' })] };

/** A Start that has not answered yet: the press keeps the spinner on, a second press does nothing. */
export const StartPending: Story = {
  decorators: [withAnswers({ read: ok(idleOrchestrationFixture()), start: 'pending' })],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /Запустить команду|Start the team/ }));
  },
};

/** Started while the runner is offline: the outcome says the first step waits for it. */
export const StartedRunnerAway: Story = {
  args: { availability: 'offline' },
  decorators: [withAnswers({ read: ok(idleOrchestrationFixture()) })],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /Запустить команду|Start the team/ }));
  },
};

/** `run-paused`: development is paused, the line in the danger tone says what to do. */
export const StartRefusedPaused: Story = {
  decorators: [withAnswers({ read: ok(idleOrchestrationFixture()), start: refused('paused', 'run-paused') })],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /Запустить команду|Start the team/ }));
  },
};

/** `orchestration-active`: a run started elsewhere; the neutral line, and the run read again shows Stop. */
export const StartRefusedActive: Story = {
  decorators: [
    withAnswers({ read: ok(idleOrchestrationFixture()), start: refused('active', 'orchestration-active') }),
  ],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /Запустить команду|Start the team/ }));
  },
};

/** No network, or a slug this bundle does not know: the generic line. */
export const StartFailedOffline: Story = {
  decorators: [withAnswers({ read: ok(idleOrchestrationFixture()), start: refused('offline') })],
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole('button', { name: /Запустить команду|Start the team/ }));
  },
};

/** The run could not be read: the state is unknown, Start stays (the Worker refuses it if a run is on). */
export const ReadFailed: Story = { decorators: [withAnswers({ read: refused('offline') })] };
