import { enrolmentIntentFixture, runnerFixture } from '@console/entities/runner';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { AddRunnerCommandStep } from './steps/command-step';
import { AddRunnerConfirmStep } from './steps/confirm-step';
import { AddRunnerEndedStep } from './steps/ended-step';
import { AddRunnerOnlineStep } from './steps/online-step';
import { AddRunnerParamsStep } from './steps/params-step';
import { AddRunnerStepIndicator } from './steps/step-indicator';

/** The add-runner wizard's steps (#634 PR 4, UX spec §6), one story per screen state the owner can meet. */
const meta: Meta = {
  title: 'Features/Add runner/Steps',
  decorators: [
    moduleMetadata({
      imports: [
        AddRunnerCommandStep,
        AddRunnerConfirmStep,
        AddRunnerEndedStep,
        AddRunnerOnlineStep,
        AddRunnerParamsStep,
        AddRunnerStepIndicator,
      ],
    }),
  ],
};

export default meta;
type Story = StoryObj;

const PROJECTS = [
  { slug: 'team-console', displayName: 'Team Console' },
  { slug: 'storify', displayName: 'Storify' },
];
const NOW = Date.parse('2026-11-11T10:02:00.000Z');
const EXPIRES = '2026-11-11T10:10:00.000Z';
const SETUP =
  'sudo /usr/local/lib/team-console-runner/bin/team-console-runner setup --url https://console.example --enrolment 01M6YSNJ00000000000000N001';
const INSTALL = {
  version: '0.3.0',
  'darwin-arm64': 'curl --proto =https --tlsv1.2 -fsSL https://github.com/… && sudo sh -c … (Apple silicon)',
  'darwin-x64': 'curl --proto =https --tlsv1.2 -fsSL https://github.com/… && sudo sh -c … (Intel)',
};

const frame = (inner: string): string => `<div style="max-width: var(--sheet-dialog-w); display: grid; gap: var(--space-5)">${inner}</div>`;

/** Step 1 while the owner count is unknown: the D3 line in its conditional wording (#878). */
export const Params: Story = {
  render: () => ({
    props: { projects: PROJECTS },
    template: frame(`<tc-add-runner-step-indicator step="params" />
      <tc-add-runner-params-step formId="story-params" [projects]="projects" [ownerCount]="null" />`),
  }),
};

/** Step 1 for an account with several owners: the D3 line as a plain statement. */
export const ParamsSeveralOwners: Story = {
  render: () => ({
    props: { projects: PROJECTS },
    template: frame(`<tc-add-runner-params-step formId="story-owners" [projects]="projects" [ownerCount]="2" />`),
  }),
};

/** Step 1 for a sole owner: no D3 line. */
export const ParamsSoleOwner: Story = {
  render: () => ({
    props: { projects: PROJECTS },
    template: frame(`<tc-add-runner-params-step formId="story-sole" [projects]="projects" [ownerCount]="1" />`),
  }),
};

/** Step 1 with the name missing. */
export const ParamsInvalid: Story = {
  render: () => ({
    props: { projects: PROJECTS },
    template: frame(
      `<tc-add-runner-params-step formId="story-invalid" [projects]="projects" [ownerCount]="1" nameError="Введите название раннера" />`,
    ),
  }),
};

/** Step 2, variant A: the verified one-liner for a release that ships `node`. */
export const CommandOneLiner: Story = {
  render: () => ({
    props: { setup: SETUP, install: INSTALL, expires: EXPIRES, now: NOW },
    template: frame(`<tc-add-runner-step-indicator step="command" />
      <tc-add-runner-command-step name="Mac mini" [setupCommand]="setup" [installCommands]="install" releaseVersion="0.3.0" [expiresAt]="expires" [now]="now" />`),
  }),
};

/** Step 2, variant B: the runbook path while the release has no one-liner. */
export const CommandRunbook: Story = {
  render: () => ({
    props: { setup: SETUP, expires: EXPIRES, now: NOW },
    template: frame(
      `<tc-add-runner-command-step name="Mac mini" [setupCommand]="setup" releaseVersion="0.2.0" [expiresAt]="expires" [now]="now" />`,
    ),
  }),
};

/** Step 2 on the iPhone: Copy stays, plus the note to run it on the Mac (decision 3). */
export const CommandPhone: Story = {
  render: () => ({
    props: { setup: SETUP, install: INSTALL, expires: EXPIRES, now: NOW },
    template: frame(
      `<tc-add-runner-step-indicator step="command" [compact]="true" />
      <tc-add-runner-command-step name="Mac mini" [setupCommand]="setup" [installCommands]="install" [expiresAt]="expires" [now]="now" [isPhone]="true" />`,
    ),
  }),
};

/** Step 3: the fingerprint, the host and the bind country as text. */
export const Confirm: Story = {
  render: () => ({
    props: { intent: enrolmentIntentFixture(), now: NOW },
    template: frame(`<tc-add-runner-step-indicator step="confirm" />
      <tc-add-runner-confirm-step [intent]="intent" [now]="now" />`),
  }),
};

/** Step 3 in the dark theme: the warning callout and the large fingerprint keep their contrast. */
export const ConfirmDark: Story = {
  ...Confirm,
  globals: { theme: 'dark' },
};

/** Step 3 on the iPhone: the fingerprint at the same 28 px, the ledger label-over-value under 360 px. */
export const ConfirmPhone: Story = {
  ...Confirm,
  globals: { viewport: { value: 'iphone', isRotated: false } },
};

/** Step 3 with a long hostname and no country from the edge. */
export const ConfirmLongHost: Story = {
  render: () => ({
    props: {
      intent: enrolmentIntentFixture({
        host: { os: 'darwin', arch: 'x64', hostname: 'a-very-long-hostname-of-the-build-machine-in-the-office.example.local' },
        boundCountry: null,
      }),
      now: NOW,
    },
    template: frame(`<tc-add-runner-confirm-step [intent]="intent" [now]="now" />`),
  }),
};

/** Step 4a: approved, waiting for the first signal. */
export const Approved: Story = {
  render: () => ({ template: frame(`<tc-add-runner-online-step name="Mac mini" />`) }),
};

/** Step 4a after five minutes: what to check on the machine. */
export const ApprovedSlow: Story = {
  render: () => ({ template: frame(`<tc-add-runner-online-step name="Mac mini" [slow]="true" />`) }),
};

/** Step 4a after fifteen minutes (#878): polling stopped, the owner re-checks by hand. */
export const ApprovedStopped: Story = {
  render: () => ({ template: frame(`<tc-add-runner-online-step name="Mac mini" [slow]="true" [gaveUp]="true" />`) }),
};

/** Step 4a while a re-check runs. */
export const ApprovedRechecking: Story = {
  render: () => ({
    template: frame(`<tc-add-runner-online-step name="Mac mini" [slow]="true" [gaveUp]="true" [rechecking]="true" />`),
  }),
};

/** Step 4b: on line. */
export const Online: Story = {
  render: () => ({
    props: { runner: runnerFixture({ name: 'Mac mini' }) },
    template: frame(`<tc-add-runner-step-indicator step="online" />
      <tc-add-runner-online-step name="Mac mini" [runner]="runner" projectScope="all" />`),
  }),
};

/** Step 4b below the minimum version. */
export const OnlineBehind: Story = {
  render: () => ({
    props: { runner: runnerFixture({ name: 'Mac mini', version: '0.1.0', belowMinimum: true }) },
    template: frame(
      `<tc-add-runner-online-step name="Mac mini" [runner]="runner" minimumVersion="0.2.0" projectScope="selected" [allowedProjects]="[]" />`,
    ),
  }),
};

export const Expired: Story = {
  render: () => ({ template: frame(`<tc-add-runner-ended-step reason="expired" />`) }),
};

export const Withdrawn: Story = {
  render: () => ({ template: frame(`<tc-add-runner-ended-step reason="withdrawn" />`) }),
};

export const Rejected: Story = {
  render: () => ({ template: frame(`<tc-add-runner-ended-step reason="rejected" />`) }),
};
