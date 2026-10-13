import { provideRouter } from '@angular/router';
import { DesignsApi } from '@console/entities/design';
import { Card } from '@console/shared/ui';
import type { DesignManifestDto } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { QuestionDesignPreviews } from './question-design-previews';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const darkTheme = { globals: { theme: 'dark' } } satisfies Partial<StoryObj>;
const phoneViewport = { globals: { viewport: { value: 'iphone', isRotated: false } } } satisfies Partial<StoryObj>;

// The Storybook static dir answers this one file route with a real render (`.storybook/public/api/...`).
const SHA = 'a'.repeat(40);

const screen = (file: string): DesignManifestDto['screens'][number] => ({
  path: `docs/design/277-design-viewer/${file}`,
  file,
  caption: file.replace(/^(?:phone|mac)-\d+-/, '').replace(/\.\w+$/, '').replace(/-/g, ' '),
  device: file.startsWith('phone-') ? 'phone' : 'mac',
  type: 'png',
  size: 1206,
  tooLarge: false,
  url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-design-viewer/${file}`,
});

// Six screens: the card shows three phone screens first, the last one with «+3» (#276 §3).
const MANIFEST: DesignManifestDto = {
  issue: 277,
  sha: SHA,
  ref: 'pull-request',
  screens: [
    screen('mac-01-list.png'),
    screen('mac-02-images.png'),
    screen('phone-01-list.png'),
    screen('phone-02-images.png'),
    screen('phone-03-all-screens.png'),
    screen('phone-04-no-access.png'),
  ],
  interactive: {
    path: 'docs/design/277-design-viewer/wireframe.html',
    url: 'https://geeera.github.io/team-console/277-design-viewer/wireframe.html',
  },
  partial: false,
};

type Scenario = 'ready' | 'loading' | 'none' | 'htmlOnly' | 'failed';

/** A scripted `DesignsApi`: every story answers the manifest in its own way, nothing is fetched. */
function designsApi(scenario: Scenario): Pick<DesignsApi, 'manifest'> {
  return {
    manifest: () => {
      switch (scenario) {
        case 'ready':
          return Promise.resolve(MANIFEST);
        case 'loading':
          return new Promise(() => undefined);
        case 'none':
          return Promise.resolve({ ...MANIFEST, screens: [], interactive: null });
        case 'htmlOnly':
          return Promise.resolve({ ...MANIFEST, screens: [] });
        case 'failed':
          return Promise.reject(new Error('story: the manifest read failed'));
      }
    },
  };
}

interface Args {
  readonly scenario: Scenario;
}

const meta: Meta<Args> = {
  title: 'Widgets/Question design previews',
  decorators: [moduleMetadata({ imports: [Card, QuestionDesignPreviews] })],
  render: (args) => ({
    props: args,
    // A plain ApplicationConfig here, not the `applicationConfig()` decorator: the renderer reads `.providers` off it.
    applicationConfig: {
      providers: [provideRouter([]), { provide: DesignsApi, useValue: designsApi(args.scenario) }],
    },
    // The previews sit inside a #276 question card, the width of the card column.
    template: `
      <tc-card style="max-width: calc(var(--sidebar-w) * 2)">
        <tc-question-design-previews slug="tc" [issue]="277" />
      </tc-card>
    `,
  }),
  args: { scenario: 'ready' },
};

export default meta;
type Story = StoryObj<Args>;

/** Three phone screens, «+3» on the last, «Все экраны (6)» and the summary line. */
export const Ready: Story = {};
export const ReadyPhone: Story = { ...phoneViewport };
export const Dark: Story = { ...darkTheme };
/** Three skeletons while the manifest loads. */
export const Loading: Story = { args: { scenario: 'loading' } };
/** The team attached no screens and there is no interactive version either. */
export const None: Story = { args: { scenario: 'none' } };
/** No screens, but an HTML wireframe: the note plus «Открыть дизайн», which opens the viewer in «Интерактивно». */
export const HtmlOnly: Story = { args: { scenario: 'htmlOnly' } };
/** The manifest could not be read: the note and «Повторить». */
export const Failed: Story = { args: { scenario: 'failed' } };
