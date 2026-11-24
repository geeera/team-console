import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoService } from '@console/shared/i18n';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { DEMO_LEAF_STORAGE, DemoLeaf, resetDemoLeafSession } from './demo-leaf';

// The kit Storybook's toolbar globals (`.storybook/stories.ts`); repeated here rather than imported across projects.
const darkTheme = { globals: { theme: 'dark' } } satisfies Partial<StoryObj>;
const reducedMotion = { globals: { motion: 'reduce' } } satisfies Partial<StoryObj>;
const phoneViewport = {
  globals: { viewport: { value: 'iphone', isRotated: false } },
} satisfies Partial<StoryObj>;

const DUE = '2026-10-16';

/** The leaf as the board would feed it: the words from the catalogue, the memory of the last visit seeded. */
@Component({
  selector: 'tc-story-demo-leaf',
  imports: [DemoLeaf],
  template: `<tc-demo-leaf [due]="due" [days]="days()" [line]="lineOf(days())" />`,
  providers: [
    {
      provide: DEMO_LEAF_STORAGE,
      useFactory: () => ({ read: () => null, write: () => undefined }),
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class DemoLeafStory {
  readonly days = input(3);
  protected readonly due = DUE;
  private readonly transloco = inject(TranslocoService);

  protected lineOf(days: number): string {
    return this.transloco.translate(days === 0 ? 'stories.demoLeaf.today' : 'stories.demoLeaf.in', {
      n: days,
    });
  }
}

/** Same, but a day has turned since the owner last looked at it. */
@Component({
  selector: 'tc-story-demo-leaf-turned',
  imports: [DemoLeaf],
  template: `<tc-demo-leaf [due]="due" [days]="days()" [line]="lineOf(days())" />`,
  providers: [
    {
      provide: DEMO_LEAF_STORAGE,
      useFactory: () => {
        const transloco = inject(TranslocoService);
        const seen = { due: DUE, days: 3, line: transloco.translate('stories.demoLeaf.in', { n: 3 }) };
        return { read: () => JSON.stringify(seen), write: () => undefined };
      },
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class DemoLeafTurnedStory {
  readonly days = input(2);
  protected readonly due = DUE;
  private readonly transloco = inject(TranslocoService);

  protected lineOf(days: number): string {
    return this.transloco.translate('stories.demoLeaf.in', { n: days });
  }
}

interface Args {
  readonly days: number;
}

const meta: Meta<Args> = {
  title: 'Widgets/Board demo leaf',
  decorators: [moduleMetadata({ imports: [DemoLeafStory, DemoLeafTurnedStory] })],
  args: { days: 3 },
  render: (args) => {
    resetDemoLeafSession();
    return { props: args, template: `<tc-story-demo-leaf [days]="days" />` };
  },
};

export default meta;
type Story = StoryObj<Args>;

const turned: Story['render'] = (args) => {
  resetDemoLeafSession();
  return { props: args, template: `<tc-story-demo-leaf-turned [days]="days" />` };
};

/** Three days to the demo. */
export const Default: Story = {};
/** The demo day: an accent leaf. */
export const Today: Story = { args: { days: 0 } };
/** A day has turned since the owner last looked: yesterday's leaf tears upward once. */
export const Tearing: Story = { args: { days: 2 }, render: turned };
export const DefaultDark: Story = { ...darkTheme };
export const TodayDark: Story = { ...darkTheme, args: { days: 0 } };
/** Reduced motion: no tear, the leaf just shows today. */
export const ReducedMotion: Story = { ...reducedMotion, args: { days: 2 }, render: turned };
export const Phone: Story = { ...phoneViewport, args: { days: 0 } };
