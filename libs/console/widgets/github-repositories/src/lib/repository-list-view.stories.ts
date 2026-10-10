import type { InputSignal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, Callout } from '@console/shared/ui';
import type { InstallationRepositoryDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { RepositoryListView } from './repository-list-view';

// Repository names and logins are data, not copy: the same in every language.
const repo = (
  name: string,
  registration: InstallationRepositoryDto['registration'] = { state: 'none' },
  isPrivate = false,
): InstallationRepositoryDto => ({ fullName: `geeera/${name}`, private: isPrivate, registration });

const LIST: readonly InstallationRepositoryDto[] = [
  repo('a-really-long-repository-name-to-check-wrapping', { state: 'none' }, true),
  repo('dotfiles'),
  repo('fieldnote', { state: 'none' }, true),
  repo('newsletter'),
  repo('storify', { state: 'none' }, true),
  repo('team-console', { state: 'active', slug: 'team-console' }),
  repo('sheltrix', { state: 'active', slug: 'sheltrix' }, true),
  repo('old-landing', { state: 'archived', slug: 'old-landing' }),
];

const LONG: readonly InstallationRepositoryDto[] = [
  ...LIST,
  ...Array.from({ length: 30 }, (_, index) => repo(`side-project-${String(index + 1).padStart(2, '0')}`)),
];

const SELECTION_URL = 'https://github.com/settings/installations/1001';
const INSTALL_URL = 'https://github.com/apps/team-console-dev/installations/new';

// The view's inputs are signals; the story's args are their plain values.
type InputValue<T> = T extends InputSignal<infer Value> ? Value : never;
type ViewInput =
  | 'connection'
  | 'status'
  | 'problem'
  | 'repositories'
  | 'rowStates'
  | 'partial'
  | 'online'
  | 'loadedAt'
  | 'refreshing'
  | 'keepInPlace'
  | 'selectionUrl'
  | 'appName'
  | 'login';
type Args = Partial<{ [Key in ViewInput]: InputValue<RepositoryListView[Key]> }>;

const template = `
  <div style="max-width: calc(var(--sidebar-w) * 3)">
    <tc-repository-list-view
      [connection]="connection"
      [status]="status"
      [problem]="problem"
      [repositories]="repositories"
      [rowStates]="rowStates"
      [keepInPlace]="keepInPlace"
      [partial]="partial"
      [online]="online"
      [loadedAt]="loadedAt"
      [refreshing]="refreshing"
      [selectionUrl]="selectionUrl"
      [appName]="appName"
      [login]="login"
    >
      <section tc-callout tc-repos-connect tone="warning" aria-labelledby="story-connect">
        <h3 tc-callout-title id="story-connect">{{ 'settings.gh.needConnect.title' | transloco }}</h3>
        <p>{{ 'overview.repos.needConnect.body' | transloco: { app: appName } }}</p>
        <button tc-button variant="primary" type="button">{{ 'settings.gh.connect' | transloco }}</button>
      </section>
    </tc-repository-list-view>
  </div>
`;

const meta: Meta<Args> = {
  title: 'Widgets/Available on GitHub',
  decorators: [
    applicationConfig({ providers: [provideRouter([])] }),
    moduleMetadata({ imports: [RepositoryListView, Button, Callout, TranslocoPipe] }),
  ],
  args: {
    connection: 'connected',
    status: 'ready',
    problem: null,
    repositories: LIST,
    rowStates: {},
    keepInPlace: new Set<string>(),
    partial: false,
    online: true,
    loadedAt: '2026-10-05T09:29:00.000Z',
    refreshing: false,
    selectionUrl: SELECTION_URL,
    appName: 'team-console-dev',
    login: 'geeera',
  },
  render: (args) => ({ props: args, template }),
};

export default meta;
type Story = StoryObj<Args>;

export const Loaded: Story = {};
export const Loading: Story = { args: { status: 'loading' } };
export const Refreshing: Story = { args: { refreshing: true } };
export const Partial: Story = { args: { partial: true } };
export const Empty: Story = { args: { repositories: [] } };
export const NotConnected: Story = { args: { connection: 'not-connected', status: 'idle' } };
export const NotInstalled: Story = {
  args: { status: 'error', problem: { kind: 'not-installed', installUrl: INSTALL_URL } },
};
export const GitHubUnavailable: Story = { args: { status: 'error', problem: { kind: 'github' } } };
export const RateLimit: Story = {
  args: { status: 'error', problem: { kind: 'rate', retryAt: '2026-10-05T09:58:00.000Z' } },
};
export const BrokenAppCredential: Story = { args: { status: 'error', problem: { kind: 'auth' } } };
export const OfflineWithList: Story = { args: { online: false } };
export const OfflineNothingLoaded: Story = {
  args: { status: 'error', problem: { kind: 'offline' }, loadedAt: null, online: false },
};
/** Every kind of row: checking, not added (See why), private, a long name, a project, archived, just added. */
export const RowKinds: Story = {
  args: {
    repositories: [
      ...LIST.slice(0, 5),
      repo('newsletter-2', { state: 'active', slug: 'newsletter-2' }),
      ...LIST.slice(5),
    ],
    rowStates: {
      'geeera/storify': { kind: 'checking' },
      'geeera/fieldnote': { kind: 'not-added', step: 3 },
    },
    keepInPlace: new Set(['geeera/newsletter-2']),
  },
};
export const LongList: Story = { args: { repositories: LONG } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const Phone: Story = { globals: { viewport: { value: 'iphone', isRotated: false } } };
