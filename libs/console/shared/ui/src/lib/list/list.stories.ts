import { provideRouter } from '@angular/router';
import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { applicationConfig, moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Chip } from '../chip/chip';
import { Button, IconButton } from '../button/button';
import { Icon } from '../icon/icon';
import { List, ListHeading, ListRow } from './list';

const projects = `
  <tc-list [attr.aria-label]="'stories.list.ariaProjects' | transloco">
    <tc-list-row button current>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Team Console</span>
      <span tc-row-subtitle>{{ 'stories.list.sprintLine' | transloco }}</span>
      <tc-chip tc-row-trailing tone="accent">3</tc-chip>
    </tc-list-row>
    <tc-list-row button>
      <tc-icon tc-row-leading name="inbox" />
      <span tc-row-title>Sheltrix</span>
      <span tc-row-subtitle>{{ 'stories.list.pausedSince' | transloco }}</span>
      <tc-chip tc-row-trailing tone="warning" dot>{{ 'stories.chip.paused' | transloco }}</tc-chip>
    </tc-list-row>
    <tc-list-row href="#settings">
      <tc-icon tc-row-leading name="settings" />
      <span tc-row-title>{{ 'stories.common.settings' | transloco }}</span>
      <tc-icon tc-row-trailing name="chevron-right" />
    </tc-list-row>
    <tc-list-row href="https://github.com/geeera/team-console" external>
      <tc-icon tc-row-leading name="github" />
      <span tc-row-title>{{ 'stories.list.external' | transloco }}</span>
      <tc-icon tc-row-trailing name="external" />
    </tc-list-row>
    <tc-list-row>
      <span tc-row-title>{{ 'stories.list.version' | transloco }}</span>
      <span tc-row-subtitle>{{ 'stories.list.staticRow' | transloco }}</span>
    </tc-list-row>
    <tc-list-row button disabled>
      <span tc-row-title>{{ 'stories.list.archive' | transloco }}</span>
      <span tc-row-subtitle>{{ 'stories.list.offline' | transloco }}</span>
    </tc-list-row>
  </tc-list>
`;

const sidebar = `
  <div style="width: var(--sidebar-w); padding: var(--space-2); background: var(--bg-sunken); border-radius: var(--r-lg)">
    <tc-list plain [attr.aria-label]="'stories.list.ariaProjects' | transloco">
      <tc-list-row button current>
        <span tc-row-title>Team Console</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Sheltrix</span>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Reader</span>
      </tc-list-row>
    </tc-list>
  </div>
`;

const withActions = `
  <div style="width: var(--sidebar-w); padding: var(--space-2); background: var(--bg-sunken); border-radius: var(--r-lg)">
    <tc-list plain [attr.aria-label]="'stories.list.ariaProjects' | transloco">
      <tc-list-row button current>
        <span tc-row-title>Team Console</span>
        <tc-chip tc-row-trailing tone="accent">3</tc-chip>
        <button tc-icon-button tc-row-action type="button" aria-pressed="true" [attr.aria-label]="'stories.list.unpin' | transloco">
          <tc-icon name="pin" />
        </button>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-title>Sheltrix</span>
        <button tc-icon-button tc-row-action type="button" aria-pressed="false" [attr.aria-label]="'stories.list.pin' | transloco">
          <tc-icon name="pin" />
        </button>
      </tc-list-row>
    </tc-list>
  </div>
`;

/** #194: a router-link row with trailing text, a muted row with no control, and a detail line beside a row action. */
const trailingText = `
  <tc-list [attr.aria-label]="'stories.list.ariaRepos' | transloco">
    <tc-list-row [link]="['/settings/projects', 'team-console']" [label]="'stories.list.repoProjectAria' | transloco: { repo: 'geeera/team-console' }">
      <span tc-row-title>team-console</span>
      <span tc-row-subtitle>geeera</span>
      <span tc-row-trailing-text>{{ 'stories.list.repoProject' | transloco }}<tc-icon name="chevron-right" size="sm" /></span>
    </tc-list-row>
    <tc-list-row muted>
      <span tc-row-title>old-landing</span>
      <span tc-row-subtitle>geeera</span>
      <span tc-row-trailing-text><tc-icon name="archive" size="sm" />{{ 'stories.list.repoArchived' | transloco }}</span>
    </tc-list-row>
    <tc-list-row>
      <span tc-row-title>fieldnote</span>
      <span tc-row-subtitle>geeera</span>
      <span tc-row-detail>{{ 'stories.list.repoNotAdded' | transloco }} · <a href="#why">{{ 'stories.list.repoSeeWhy' | transloco }}</a></span>
      <button tc-row-action tc-button type="button">{{ 'stories.list.repoAdd' | transloco }}</button>
    </tc-list-row>
  </tc-list>
`;

/**
 * #374: a nowrap title (a repository name) ends in an ellipsis inside its column, beside trailing text, a muted
 * trailing label and a row action alike. The nowrap rule is the consumer's; the kit only has to let it shrink.
 */
const longNowrapTitle = `
  <tc-list [attr.aria-label]="'stories.list.ariaRepos' | transloco">
    <tc-list-row [link]="['/settings/projects', 'long']" [label]="'stories.list.repoProjectAria' | transloco: { repo: 'geeera/' + longName }">
      <span tc-row-title class="story-nowrap">{{ longName }}</span>
      <span tc-row-subtitle>geeera</span>
      <span tc-row-trailing-text>{{ 'stories.list.repoProject' | transloco }}<tc-icon name="chevron-right" size="sm" /></span>
    </tc-list-row>
    <tc-list-row muted>
      <span tc-row-title class="story-nowrap">{{ longName }}</span>
      <span tc-row-subtitle>geeera</span>
      <span tc-row-trailing-text><tc-icon name="archive" size="sm" />{{ 'stories.list.repoArchived' | transloco }}</span>
    </tc-list-row>
    <tc-list-row>
      <span tc-row-title class="story-nowrap">{{ longName }}</span>
      <span tc-row-subtitle>geeera</span>
      <button tc-row-action tc-button type="button">{{ 'stories.list.repoAdd' | transloco }}</button>
    </tc-list-row>
  </tc-list>
`;

const longNowrapTitleStory = {
  render: () => ({
    template: longNowrapTitle,
    props: { longName: 'a-really-long-repository-name-to-check-wrapping' },
    styles: [
      '.story-nowrap { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    ],
  }),
} satisfies Partial<StoryObj<List>>;

/**
 * #766: a `grid` list in a size container. From an 880 px container (`--cq-grid-min`) the rows are cards, the leading
 * slot across the top, the kicker over the title, the headings starting a row; under it the same DOM is the row list.
 */
const gridCards = `
  <div [style.max-width]="maxWidth" style="container-type: inline-size">
    <tc-list grid [attr.aria-label]="'stories.list.ariaProjects' | transloco">
      <tc-list-heading>{{ 'stories.list.ariaProjects' | transloco }} <span>3</span></tc-list-heading>
      <tc-list-row href="https://github.com/geeera/team-console" external>
        <span tc-row-kicker><tc-icon name="check" size="sm" />{{ 'stories.list.repoProject' | transloco }}</span>
        <span tc-row-title>Team Console</span>
        <span tc-row-subtitle>{{ 'stories.list.sprintLine' | transloco }}</span>
        <tc-chip tc-row-trailing>{{ 'stories.list.repoProject' | transloco }}</tc-chip>
      </tc-list-row>
      <tc-list-row button>
        <span tc-row-leading class="story-thumb"></span>
        <span tc-row-title>Sheltrix</span>
        <span tc-row-subtitle>{{ 'stories.list.pausedSince' | transloco }}</span>
      </tc-list-row>
      <tc-list-row>
        <span tc-row-kicker><tc-icon name="archive" size="sm" />{{ 'stories.list.repoArchived' | transloco }}</span>
        <span tc-row-title>{{ 'stories.list.version' | transloco }}</span>
        <span tc-row-subtitle>{{ 'stories.list.staticRow' | transloco }}</span>
      </tc-list-row>
      <tc-list-heading>{{ 'stories.list.ariaRepos' | transloco }} <span>1</span></tc-list-heading>
      <tc-list-row href="#fieldnote">
        <span tc-row-title>fieldnote</span>
        <span tc-row-subtitle>geeera</span>
      </tc-list-row>
    </tc-list>
  </div>
`;

const gridStory = (maxWidth: string) =>
  ({
    render: () => ({
      template: gridCards,
      props: { maxWidth },
      styles: [
        '.story-thumb { display: block; width: 100%; min-width: var(--thumb-size); aspect-ratio: var(--thumb-ratio); background: var(--bg-sunken); }',
      ],
    }),
  }) satisfies Partial<StoryObj<List>>;

const meta: Meta<List> = {
  title: 'Kit/List',
  component: List,
  decorators: [
    applicationConfig({ providers: [provideRouter([])] }),
    moduleMetadata({ imports: [List, ListHeading, ListRow, Button, Chip, Icon, IconButton, TranslocoPipe] }),
  ],
  render: () => ({ template: projects }),
};

export default meta;
type Story = StoryObj<List>;

export const Rows: Story = {};
export const Sidebar: Story = { render: () => ({ template: sidebar }) };
export const WithRowActions: Story = { render: () => ({ template: withActions }) };
export const TrailingTextAndDetail: Story = { render: () => ({ template: trailingText }) };
export const TrailingTextDark: Story = { ...darkTheme, render: () => ({ template: trailingText }) };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
export const LongNowrapTitle: Story = { ...longNowrapTitleStory };
export const LongNowrapTitlePhone: Story = { ...phoneViewport, ...longNowrapTitleStory };
export const LongNowrapTitlePhoneDark: Story = {
  globals: { ...phoneViewport.globals, ...darkTheme.globals },
  ...longNowrapTitleStory,
};
export const GridCards: Story = { ...gridStory('none') };
export const GridCardsDark: Story = { ...darkTheme, ...gridStory('none') };
/** Under 880 px of container the grid list is the row list, its headings hidden. */
export const GridNarrowContainer: Story = { ...gridStory('var(--log-max)') };
