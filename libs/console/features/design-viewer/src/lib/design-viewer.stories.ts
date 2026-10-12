import { HttpErrorResponse } from '@angular/common/http';
import { afterNextRender, ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { provideRouter } from '@angular/router';
import { DesignsApi } from '@console/entities/design';
import { EmbedOriginsApi } from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button } from '@console/shared/ui';
import type { DesignManifestDto } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { DesignViewer } from './design-viewer';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const darkTheme = { globals: { theme: 'dark' } } satisfies Partial<StoryObj>;
const reducedMotion = { globals: { motion: 'reduce' } } satisfies Partial<StoryObj>;
const phoneViewport = {
  globals: { viewport: { value: 'iphone', isRotated: false } },
} satisfies Partial<StoryObj>;

// The Storybook static dir answers this one file route with a real render (`.storybook/public/api/...`).
const SHA = 'a'.repeat(40);
const PAGES = 'https://geeera.github.io';

const screen = (file: string, extra: Partial<DesignManifestDto['screens'][number]> = {}) => ({
  path: `docs/design/277-design-viewer/${file}`,
  file,
  caption: file
    .replace(/^(?:phone|mac)-\d+-/, '')
    .replace(/\.\w+$/, '')
    .replace(/-/g, ' '),
  device: file.startsWith('phone-') ? ('phone' as const) : ('mac' as const),
  type: 'png' as const,
  size: 1206,
  tooLarge: false,
  url: `https://github.com/geeera/team-console/blob/${SHA}/docs/design/277-design-viewer/${file}`,
  ...extra,
});

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
    screen('phone-04-too-large.png', { tooLarge: true, size: 12_582_912 }),
  ],
  interactive: {
    path: 'docs/design/277-design-viewer/wireframe.html',
    url: `${PAGES}/team-console/277-design-viewer/wireframe.html`,
  },
  partial: false,
};

type Scenario = 'images' | 'noImages' | 'noAccess' | 'offline' | 'interactiveAllowed';

function designsApi(scenario: Scenario): Pick<DesignsApi, 'manifest'> {
  return {
    manifest: () => {
      switch (scenario) {
        case 'noImages':
          return Promise.resolve({ ...MANIFEST, screens: [] });
        case 'noAccess':
          return Promise.reject(new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));
        case 'offline':
          return Promise.reject(new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' }));
        default:
          return Promise.resolve(MANIFEST);
      }
    },
  };
}

function embedOriginsApi(scenario: Scenario): Pick<EmbedOriginsApi, 'origins'> {
  return { origins: () => Promise.resolve(scenario === 'interactiveAllowed' ? [PAGES] : []) };
}

/** Opens the viewer as soon as the story renders, so the story shows the viewer itself. */
@Component({
  selector: 'tc-story-design-viewer-host',
  imports: [Button, TranslocoPipe],
  template: `
    <button tc-button variant="primary" type="button" (click)="open()">
      {{ 'designs.row.open' | transloco }}
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class ViewerHost {
  private readonly viewer = inject(DesignViewer);
  readonly title = input('Designs viewed inside the console');

  constructor() {
    afterNextRender(() => this.open());
  }

  protected open(): void {
    this.viewer.open({ slug: 'tc', issue: 277, title: this.title() });
  }
}

interface Args {
  readonly scenario: Scenario;
}

const meta: Meta<Args> = {
  title: 'Features/Design viewer',
  decorators: [moduleMetadata({ imports: [ViewerHost] })],
  // The viewer renders in the CDK overlay container, outside the story root; axe must see both.
  parameters: { a11y: { context: 'body' } },
  render: (args) => ({
    props: args,
    // A plain ApplicationConfig, not the `applicationConfig()` decorator: the renderer reads `.providers` off it.
    applicationConfig: {
      providers: [
        provideRouter([]),
        { provide: DesignsApi, useValue: designsApi(args.scenario) },
        { provide: EmbedOriginsApi, useValue: embedOriginsApi(args.scenario) },
      ],
    },
    template: '<tc-story-design-viewer-host />',
  }),
  args: { scenario: 'images' },
};

export default meta;
type Story = StoryObj<Args>;

/** «Картинки» on the Mac: one screen fitted to the stage, iPhone/Mac switch, ‹ Назад · 2 из 6 · Вперёд ›. */
export const Images: Story = {};
export const ImagesPhone: Story = { ...phoneViewport };
export const Dark: Story = { ...darkTheme };
export const ReducedMotion: Story = { ...reducedMotion };
/** «В этом дизайне нет картинок» with the interactive version one tap away. */
export const NoImages: Story = { args: { scenario: 'noImages' } };
/** GitHub does not show the repository to the app: «Нет доступа к файлам дизайна». */
export const NoAccess: Story = { args: { scenario: 'noAccess' } };
export const Offline: Story = { args: { scenario: 'offline' } };
/** GitHub Pages is one of the project's embed origins: the wireframe in the strict frame (the page itself 404s here). */
export const InteractiveAllowed: Story = { args: { scenario: 'interactiveAllowed' } };
