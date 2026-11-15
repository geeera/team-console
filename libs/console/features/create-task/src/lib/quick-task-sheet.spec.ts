import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  itemFixture,
  ItemsApi,
  type CreateQuickTaskInput,
  type TrackerFailure,
  type TrackerRead,
  type TrackerWrite,
} from '@console/entities/item';
import { provideConsoleI18n } from '@console/shared/i18n';
import {
  memoryPersistedStateStorage,
  PERSISTED_STATE_STORAGE,
  PersistedStateStore,
} from '@console/shared/persisted-state';
import { DIALOG_DATA, DialogRef } from '@console/shared/ui';
import type { ItemDto, ProjectDto, TrackerSprintDto } from '@shared/contracts';
import { QuickTaskSheet, type QuickTaskData } from './quick-task-sheet';

function sprint(number: number, dueOn: string): TrackerSprintDto {
  return {
    number,
    title: `Sprint ${String(number).padStart(2, '0')}`,
    dueOn,
    state: 'open',
    description: '',
    createdAt: '2030-01-01T00:00:00Z',
    closedAt: null,
    openCount: 0,
  };
}

const PROJECT = {
  slug: 'team-console',
  displayName: 'team-console',
  repo: 'geeera/team-console',
} as ProjectDto;
const SPRINTS = [sprint(4, '2031-01-15'), sprint(5, '2031-01-29')];
const failed = (kind: TrackerFailure['kind'], field: string | null = null): TrackerWrite<ItemDto> => ({
  ok: false,
  failure: { kind, field, retryAfter: null },
});

async function render(answers: TrackerWrite<ItemDto>[], sprints: () => TrackerSprintDto[] = () => SPRINTS) {
  const calls: { input: CreateQuickTaskInput; key: string }[] = [];
  const sprintReads = { n: 0 };
  const close = vi.fn();
  const storage = memoryPersistedStateStorage();
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      provideRouter([]),
      { provide: PERSISTED_STATE_STORAGE, useValue: storage },
      { provide: DialogRef, useValue: { close, disableClose: false } },
      {
        provide: DIALOG_DATA,
        useValue: { projects: [PROJECT], slug: 'team-console', into: signal('') } satisfies QuickTaskData,
      },
      {
        provide: ItemsApi,
        useValue: {
          sprints: async (): Promise<TrackerRead<TrackerSprintDto[]>> => {
            sprintReads.n += 1;
            return { ok: true, value: sprints() };
          },
          freezeDays: async (): Promise<TrackerRead<number>> => ({ ok: true, value: 2 }),
          createItem: async (_slug: string, input: CreateQuickTaskInput, key: string) => {
            calls.push({ input, key });
            return answers.shift() ?? failed('unknown');
          },
        },
      },
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
  const fixture = TestBed.createComponent(QuickTaskSheet);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const stable = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  };
  await stable();
  const type = async (testId: string, value: string): Promise<void> => {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
    if (field === null) throw new Error(`no ${testId}`);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await stable();
  };
  const create = async (): Promise<void> => {
    root.querySelector<HTMLButtonElement>('[data-testid="quick-task-create"]')?.click();
    await stable();
  };
  return {
    root,
    calls,
    close,
    type,
    create,
    stable,
    sprintReads,
    store: TestBed.inject(PersistedStateStore),
  };
}

const checkedTarget = (root: HTMLElement): string | undefined =>
  root.querySelector<HTMLInputElement>('[data-testid="quick-task-sprints"] input:checked')?.value;

describe('QuickTaskSheet (#107)', () => {
  it('creates one item as typed: a feature in the next sprint, no status sent', async () => {
    const item = itemFixture({ number: 12, key: 'TC-12', title: 'Show the last run', sprint: 5 });
    const { root, calls, type, create } = await render([{ ok: true, value: item, replayed: false }]);
    expect(checkedTarget(root)).toBe('next');
    await type('quick-task-title', '  Show the last run ');
    await create();

    expect(calls).toEqual([
      {
        input: { title: 'Show the last run', body: '', kind: 'feature', sprint: 5 },
        key: expect.any(String),
      },
    ]);
    expect(calls[0]?.input).not.toHaveProperty('status');
    expect(root.querySelector('[data-testid="quick-task-done"]')?.textContent).toContain(
      'Задача TC-12 создана',
    );
    expect(root.textContent).toContain('Добавлена в Sprint 05.');
    expect(root.querySelector('[data-testid="quick-task-open"]')?.getAttribute('href')).toBe(
      '/p/team-console/t/12',
    );
  });

  it('refuses an empty title without a request and says why', async () => {
    const { root, calls, create } = await render([]);
    await create();
    expect(calls).toHaveLength(0);
    expect(root.textContent).toContain('Напишите название задачи.');
  });

  it('keeps the text as plain text, notes a command-like line, and counts near the cap', async () => {
    const { root, calls, type, create } = await render([failed('network')]);
    await type('quick-task-title', 'x'.repeat(210));
    expect(root.textContent).toContain('210 / 256');
    await type('quick-task-title', 'Ship it');
    await type('quick-task-body', 'Some <b>bold</b>\n/approve');
    expect(root.querySelector('[data-testid="quick-task-command-note"]')).not.toBeNull();
    await create();
    expect(calls[0]?.input.body).toBe('Some <b>bold</b>\n/approve');
    await type('quick-task-title', 'y'.repeat(260));
    expect(root.textContent).toContain('Больше 256 символов: сократите на 4.');
  });

  it('retries a dropped send with the same key and keeps the draft until it lands', async () => {
    const item = itemFixture({ number: 13, key: 'TC-13', sprint: 5 });
    const { root, calls, type, create, store } = await render([
      failed('timeout'),
      { ok: true, value: item, replayed: true },
    ]);
    await type('quick-task-title', 'Retry me');
    await create();
    expect(root.querySelector('[data-testid="quick-task-failure"]')?.getAttribute('data-kind')).toBe(
      'timeout',
    );
    expect(root.querySelector('[data-testid="quick-task-create"]')?.textContent?.trim()).toBe('Повторить');
    expect(store.quickTaskDraft()?.title).toBe('Retry me');

    await create();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(store.quickTaskDraft()).toBeUndefined();
  });

  it('after a key-reused refusal keeps the text and the key until «Отправить как новую» mints a fresh one', async () => {
    const item = itemFixture({ number: 15, key: 'TC-15', sprint: 5 });
    const { root, calls, type, create, store } = await render([
      failed('timeout'),
      failed('key-reused'),
      { ok: true, value: item, replayed: false },
    ]);
    await type('quick-task-title', 'First wording');
    await create();
    await type('quick-task-title', 'Second wording');
    await create();
    expect(calls[1]?.key).toBe(calls[0]?.key);
    const block = root.querySelector('[data-testid="quick-task-failure"]');
    expect(block?.getAttribute('data-kind')).toBe('key-reused');
    expect(block?.textContent).toContain('Первая отправка могла дойти.');
    expect(root.querySelector<HTMLInputElement>('[data-testid="quick-task-title"]')?.value).toBe(
      'Second wording',
    );
    expect(store.quickTaskDraft()?.title).toBe('Second wording');

    root.querySelector<HTMLButtonElement>('[data-testid="quick-task-send-as-new"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(3);
    expect(calls[2]?.input.title).toBe('Second wording');
    expect(calls[2]?.key).not.toBe(calls[0]?.key);
    expect(store.quickTaskDraft()).toBeUndefined();
  });

  it('after a frozen sprint offers the backlog in one tap and never the same sprint again', async () => {
    const item = itemFixture({ number: 14, key: 'TC-14', sprint: null });
    const { root, calls, type, create } = await render([
      failed('frozen'),
      { ok: true, value: item, replayed: false },
    ]);
    await type('quick-task-title', 'Late idea');
    await create();
    const block = root.querySelector('[data-testid="quick-task-failure"]');
    expect(block?.textContent).toContain('Sprint 05 не берёт новые задачи до демо');
    expect(root.querySelector('[data-testid="quick-task-to-next"]')).toBeNull();
    expect(root.querySelector('label[data-target="next"]')?.classList).toContain('tc-choice--off');

    root.querySelector<HTMLButtonElement>('[data-testid="quick-task-to-backlog"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.input.sprint)).toEqual([5, null]);
    expect(calls[1]?.key).toBe(calls[0]?.key);
  });

  it('reloads the sprints after a 422 on the sprint and keeps the text', async () => {
    let sprints = SPRINTS;
    const { root, type, create, stable, sprintReads } = await render(
      [failed('invalid', 'sprint')],
      () => sprints,
    );
    await type('quick-task-title', 'Keep me');
    sprints = [sprint(4, '2031-01-15')];
    await create();
    await stable();
    expect(sprintReads.n).toBe(2);
    expect(root.textContent).toContain('Этот спринт закрылся или исчез');
    expect(root.querySelector<HTMLInputElement>('[data-testid="quick-task-title"]')?.value).toBe('Keep me');
    expect(checkedTarget(root)).toBe('backlog');
  });

  it('keeps every keystroke as the device draft with one key', async () => {
    const { type, store } = await render([]);
    await type('quick-task-title', 'Draft');
    const first = store.quickTaskDraft();
    await type('quick-task-body', 'More');
    expect(store.quickTaskDraft()).toMatchObject({ slug: 'team-console', title: 'Draft', body: 'More' });
    expect(store.quickTaskDraft()?.idempotencyKey).toBe(first?.idempotencyKey);
    await type('quick-task-title', '');
    await type('quick-task-body', ' ');
    expect(store.quickTaskDraft()).toBeUndefined();
  });
});
