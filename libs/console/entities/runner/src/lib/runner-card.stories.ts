import { TranslocoPipe } from '@console/shared/i18n';
import { Button } from '@console/shared/ui';
import type { RunnerDto } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { RunnerCard } from './runner-card';
import { RUNNER_FIXTURE_IDS, runnerFixture } from './runner.fixture';

interface Args {
  readonly runner: RunnerDto;
  readonly minimumVersion: string | null;
  readonly withActions: boolean;
}

const meta: Meta<Args> = {
  title: 'Entities/Runner card',
  decorators: [moduleMetadata({ imports: [Button, RunnerCard, TranslocoPipe] })],
  render: (args) => ({
    props: args,
    template: `
      <div style="max-width: calc(var(--sidebar-w) * 2)">
        <tc-runner-card [runner]="runner" [minimumVersion]="minimumVersion">
          @if (withActions) {
            <span tc-runner-actions style="display: flex; gap: var(--space-2)">
              <button tc-button size="sm" type="button">{{ 'runners.projects.edit' | transloco }}</button>
              <button tc-button size="sm" type="button" variant="danger">{{ 'runners.revoke.open' | transloco }}</button>
            </span>
          }
        </tc-runner-card>
      </div>
    `,
  }),
  args: { runner: runnerFixture(), minimumVersion: '0.2.0', withActions: true },
};

export default meta;
type Story = StoryObj<Args>;

/** On the owner's Mac, polled a minute ago (#464). */
export const Online: Story = {};
export const Offline: Story = { args: { runner: runnerFixture({ online: false }) } };
/** Enrolled, never called since: the code was used but the daemon is not running. */
export const NeverSeen: Story = { args: { runner: runnerFixture({ online: false, lastSeenAt: null, lastSeenCountry: null }) } };
/** Below `RUNNER_MINIMUM_VERSION`: the chip and the minimum beside the version. */
export const BelowMinimum: Story = { args: { runner: runnerFixture({ version: '0.1.0', belowMinimum: true }) } };
/** Threat model C4 detection: a call from a new country. */
export const Suspect: Story = {
  args: { runner: runnerFixture({ suspect: { at: '2026-11-11T09:40:00.000Z', reason: 'new-country' } }) },
};
/** #571: hit the Claude usage limit; claims nothing until the reset time, then resumes on its own. */
export const UsageLimit: Story = {
  args: { runner: runnerFixture({ online: false, pause: { reason: 'usage-limit', until: '2026-11-11T14:30:00.000Z' } }) },
};
export const RateLimit: Story = {
  args: { runner: runnerFixture({ pause: { reason: 'rate-limit', until: '2026-11-11T10:20:00.000Z' } }) },
};
export const Container: Story = {
  args: {
    runner: runnerFixture({
      id: RUNNER_FIXTURE_IDS.vps,
      name: 'Hetzner VPS',
      isolation: 'container',
      host: { os: 'linux', arch: 'x64', hostname: 'vps-1' },
      capabilities: { local: false, maxConcurrency: 2 },
      allowedProjects: ['team-console', 'storify'],
    }),
  },
};
export const NoProjects: Story = { args: { runner: runnerFixture({ allowedProjects: [] }) } };
export const Revoked: Story = {
  args: {
    runner: runnerFixture({ revokedAt: '2026-11-11T10:00:00.000Z', online: false }),
    withActions: false,
  },
};
