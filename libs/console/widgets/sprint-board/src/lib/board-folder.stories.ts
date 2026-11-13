import { provideRouter } from '@angular/router';
import { itemFixture, ItemsApi, type TrackerRead } from '@console/entities/item';
import type { ItemStatus, ItemSummaryDto, TrackerSprintDto } from '@shared/contracts';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { BoardFolder, type BoardFolderSpec } from './board-folder';

type Scenario = 'loaded' | 'large' | 'empty' | 'loading' | 'error' | 'offline';

const STATUSES: readonly ItemStatus[] = ['proposed', 'approved', 'blocked'];

function tasks(count: number): ItemSummaryDto[] {
  return Array.from({ length: count }, (_, index) =>
    itemFixture({
      number: 400 + index,
      key: `TC-${String(400 + index)}`,
      title: `Task ${String(400 + index)}`,
      kind: index % 3 === 0 ? 'bug' : 'feature',
      status: STATUSES[index % STATUSES.length] ?? 'approved',
      sprint: 5,
    }),
  );
}

/** The folder's one read, answered as the scenario says; `loading` never answers. */
function itemsApi(scenario: Scenario): Pick<ItemsApi, 'items'> {
  const answers: Record<Exclude<Scenario, 'loading'>, TrackerRead<ItemSummaryDto[]>> = {
    loaded: { ok: true, value: tasks(5) },
    large: { ok: true, value: tasks(75).map((task) => ({ ...task, status: 'approved' as const })) },
    empty: { ok: true, value: [] },
    error: { ok: false, reason: 'error' },
    offline: { ok: false, reason: 'offline' },
  };
  return {
    items: (): Promise<TrackerRead<ItemSummaryDto[]>> =>
      scenario === 'loading' ? new Promise(() => undefined) : Promise.resolve(answers[scenario]),
  };
}

const SPRINT: TrackerSprintDto = {
  number: 5,
  title: 'Sprint 05',
  dueOn: '2026-12-11',
  state: 'open',
  description: '',
  createdAt: '2026-11-13T00:00:00Z',
  closedAt: null,
  openCount: 5,
};

interface Args {
  readonly scenario: Scenario;
  readonly folder: BoardFolderSpec;
  readonly open: boolean;
}

const meta: Meta<Args> = {
  title: 'Widgets/Board folder',
  decorators: [moduleMetadata({ imports: [BoardFolder] })],
  render: (args) => ({
    props: args,
    // A plain ApplicationConfig: the renderer reads `.providers` off it, per story.
    applicationConfig: {
      providers: [provideRouter([]), { provide: ItemsApi, useValue: itemsApi(args.scenario) }],
    },
    template: `<tc-board-folder slug="team-console" [folder]="folder" [open]="open" />`,
  }),
  args: { scenario: 'loaded', folder: { kind: 'next', sprint: SPRINT, openCount: 5 }, open: true },
};

export default meta;
type Story = StoryObj<Args>;

/** Collapsed: the header only — title, demo date, «N open» and Show tasks; nothing is read. */
export const Collapsed: Story = { args: { open: false } };
/** Skeleton rows, `aria-busy`, «Загружаем: Sprint 05…» announced. */
export const Loading: Story = { args: { scenario: 'loading' } };
/** Lanes with items only, the kind word first under each title. */
export const Loaded: Story = {};
/** A later sprint uses the same folder with the «Later» kicker. */
export const Later: Story = { args: { folder: { kind: 'later', sprint: { ...SPRINT, number: 6, title: 'Sprint 06' }, openCount: 5 } } };
/** One lane of 75: 30 rows, then «Show 30 more · 45 left». */
export const LargeLane: Story = { args: { scenario: 'large', folder: { kind: 'backlog', sprint: null, openCount: 75 } } };
export const EmptyNext: Story = { args: { scenario: 'empty', folder: { kind: 'next', sprint: SPRINT, openCount: 0 } } };
export const EmptyBacklog: Story = { args: { scenario: 'empty', folder: { kind: 'backlog', sprint: null, openCount: 0 } } };
/** An alert inside the folder with Try again; the rest of the board is untouched. */
export const Failed: Story = { args: { scenario: 'error' } };
/** Loads by itself on the `online` event; Try again too. */
export const Offline: Story = { args: { scenario: 'offline' } };
