import { List, ListRow } from '@console/shared/ui';
import type { DesignManifestDto } from '@shared/contracts';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { DesignPreview } from './design-preview';
import { DesignSummary } from './design-summary';
import { DesignsApi } from './designs.api';

// The Storybook static dir answers this one file route with a real render (`.storybook/public/api/...`).
const SHA = 'a'.repeat(40);
const screen = (file: string): DesignManifestDto['screens'][number] => ({
  path: `docs/design/277-design-viewer/${file}`,
  file,
  caption: file.replace(/^(?:phone|mac)-\d+-/, '').replace(/\.\w+$/, ''),
  device: file.startsWith('phone-') ? 'phone' : 'mac',
  type: 'png',
  size: 1206,
  tooLarge: false,
  url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-design-viewer/${file}`,
});

const MANIFEST: DesignManifestDto = {
  issue: 277,
  sha: SHA,
  ref: 'pull-request',
  screens: [screen('phone-01-list.png'), screen('phone-02-images.png'), screen('mac-01-list.png')],
  interactive: {
    path: 'docs/design/277-design-viewer/wireframe.html',
    url: 'https://geeera.github.io/team-console/277-design-viewer/wireframe.html',
  },
  partial: false,
};

type Answer = 'thumbnail' | 'htmlOnly' | 'nothing' | 'loading' | 'failed';

/** A scripted `DesignsApi`: every story answers the manifest in its own way, nothing is fetched. */
function designsApi(answer: Answer): Pick<DesignsApi, 'manifest'> {
  return {
    manifest: () => {
      switch (answer) {
        case 'thumbnail':
          return Promise.resolve(MANIFEST);
        case 'htmlOnly':
          return Promise.resolve({ ...MANIFEST, screens: [] });
        case 'nothing':
          return Promise.resolve({ ...MANIFEST, screens: [], interactive: null });
        case 'loading':
          return new Promise(() => undefined);
        case 'failed':
          return Promise.reject(new Error('story: the manifest read failed'));
      }
    },
  };
}

interface Args {
  readonly answer: Answer;
}

const meta: Meta<Args> = {
  title: 'Entities/Design preview',
  decorators: [moduleMetadata({ imports: [DesignPreview, DesignSummary, List, ListRow] })],
  render: (args) => ({
    props: args,
    applicationConfig: applicationConfig({
      providers: [{ provide: DesignsApi, useValue: designsApi(args.answer) }],
    }),
    template: `
      <tc-list style="max-width: calc(var(--sidebar-w) * 2)" aria-label="Designs">
        <tc-list-row button>
          <tc-design-preview tc-row-leading slug="tc" [issue]="277" />
          <span tc-row-title>Designs viewed inside the console</span>
          <span tc-row-subtitle><tc-design-summary slug="tc" [issue]="277" /></span>
        </tc-list-row>
      </tc-list>
      <div style="margin-top: var(--space-4); max-width: calc(var(--sidebar-w) * 2)">
        <tc-design-preview variant="card" slug="tc" [issue]="277" />
      </div>
    `,
  }),
  args: { answer: 'thumbnail' },
};

export default meta;
type Story = StoryObj<Args>;

/** The row's 56 px thumbnail and the card-wide preview the #276 question cards use. */
export const Thumbnail: Story = {};
export const Loading: Story = { args: { answer: 'loading' } };
/** Only an HTML wireframe: an «HTML» placeholder and «только интерактивная версия». */
export const HtmlOnly: Story = { args: { answer: 'htmlOnly' } };
export const Nothing: Story = { args: { answer: 'nothing' } };
export const Failed: Story = { args: { answer: 'failed' } };
