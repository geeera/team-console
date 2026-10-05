import { TranslocoPipe } from '@console/shared/i18n';
import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { darkTheme, phoneViewport, reducedMotion } from '../../../.storybook/stories';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';
import { StatusCard } from './status-card';

const states = `
  <div style="display: grid; gap: var(--space-6); max-width: var(--log-max)">
    <div tc-status-card loading [loadingLabel]="'stories.statusCard.checking' | transloco"></div>
    <div tc-status-card>
      <div tc-status-card-row>
        <span tc-status-card-mark aria-hidden="true"><tc-icon name="bell-off" size="sm" /></span>
        <h3 tc-status-card-title>{{ 'stories.statusCard.offTitle' | transloco }}</h3>
      </div>
      <p tc-status-card-body>{{ 'stories.statusCard.offBody' | transloco }}</p>
      <div tc-status-card-actions>
        <button tc-button variant="primary" type="button">
          <tc-icon name="bell" />{{ 'stories.statusCard.turnOn' | transloco }}
        </button>
      </div>
      <p tc-status-card-note>{{ 'stories.statusCard.hint' | transloco }}</p>
    </div>
    <div tc-status-card tone="success">
      <div tc-status-card-row>
        <span tc-status-card-mark aria-hidden="true"><tc-icon name="check" size="sm" /></span>
        <div tc-status-card-who>
          <h3 tc-status-card-title>{{ 'stories.statusCard.onTitle' | transloco }}</h3>
          <p tc-status-card-meta>{{ 'stories.statusCard.onMeta' | transloco }}</p>
        </div>
      </div>
      <div tc-status-card-actions>
        <button tc-button type="button"><tc-icon name="bell" />{{ 'stories.statusCard.test' | transloco }}</button>
        <button tc-button variant="quiet" type="button">{{ 'stories.statusCard.turnOff' | transloco }}</button>
      </div>
    </div>
    <div tc-status-card tone="warning">
      <div tc-status-card-row>
        <span tc-status-card-mark aria-hidden="true"><tc-icon name="bell-off" size="sm" /></span>
        <h3 tc-status-card-title>{{ 'stories.statusCard.blockedTitle' | transloco }}</h3>
      </div>
      <p tc-status-card-body>{{ 'stories.statusCard.blockedBody' | transloco }}</p>
      <p tc-status-card-note><tc-icon name="offline" size="sm" />{{ 'stories.statusCard.offline' | transloco }}</p>
    </div>
    <div tc-status-card tone="danger" role="alert">
      <h3 tc-status-card-title>{{ 'stories.statusCard.errorTitle' | transloco }}</h3>
      <p tc-status-card-body>{{ 'stories.statusCard.errorBody' | transloco }}</p>
    </div>
  </div>
`;

const meta: Meta<StatusCard> = {
  title: 'Kit/StatusCard',
  component: StatusCard,
  decorators: [moduleMetadata({ imports: [Button, Icon, StatusCard, TranslocoPipe] })],
  render: () => ({ template: states }),
};

export default meta;
type Story = StoryObj<StatusCard>;

export const States: Story = {};
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
export const Phone: Story = { ...phoneViewport };
