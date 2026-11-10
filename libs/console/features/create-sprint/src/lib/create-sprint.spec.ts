import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ItemsApi, type TrackerWrite } from '@console/entities/item';
import { provideConsoleI18n } from '@console/shared/i18n';
import { DIALOG_DATA, DialogRef, Sheet } from '@console/shared/ui';
import type { TrackerSprintDto } from '@shared/contracts';
import { of } from 'rxjs';
import { CreateSprint } from './create-sprint';
import { CreateSprintDialog, sprintNameOf, type CreateSprintData } from './create-sprint-dialog';

const SPRINTS_URL = '/api/v1/projects/team-console/sprints';
const FREEZE_URL = '/api/v1/projects/team-console/sprint-freeze';
const SPRINT_2: TrackerSprintDto = {
  number: 2,
  title: 'Sprint 02',
  dueOn: '2026-11-27',
  state: 'open',
  description: '',
  createdAt: 'x',
  closedAt: null,
};

describe('CreateSprint', () => {
  function setup() {
    const sheet = {
      open: vi.fn(() => ({ closed: of(undefined) })),
      confirm: vi.fn(async () => true),
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: Sheet, useValue: sheet },
      ],
    });
    const service = TestBed.inject(CreateSprint);
    service.now = () => new Date(2026, 10, 5, 12);
    return { service, sheet, http: TestBed.inject(HttpTestingController) };
  }

  const dataOf = (sheet: { open: ReturnType<typeof vi.fn> }): CreateSprintData =>
    (sheet.open.mock.calls[0]?.[1] as { data: CreateSprintData }).data;

  it("suggests the next name, 14 days after the latest demo, with the project's freeze days (#457)", async () => {
    const { service, sheet, http } = setup();
    const opened = service.open({ slug: 'team-console' });
    http.expectOne(SPRINTS_URL).flush({ sprints: [SPRINT_2] });
    http.expectOne(FREEZE_URL).flush({ freezeDays: 3 });
    await opened;
    expect(sheet.open).toHaveBeenCalledWith(
      CreateSprintDialog,
      expect.objectContaining({ title: 'Новый спринт' }),
    );
    expect(dataOf(sheet)).toMatchObject({
      slug: 'team-console',
      suggestedName: 'Sprint 03',
      today: '2026-11-05',
      dueOn: '2026-12-11',
      freezeDays: 3,
    });
    expect(dataOf(sheet).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to the plugin's two freeze days when project.yml cannot be read", async () => {
    const { service, sheet, http } = setup();
    const opened = service.open({ slug: 'team-console' });
    http.expectOne(SPRINTS_URL).flush({ sprints: [] });
    http
      .expectOne(FREEZE_URL)
      .flush({ type: 'x', title: 'x', status: 502 }, { status: 502, statusText: 'Bad Gateway' });
    await opened;
    expect(dataOf(sheet)).toMatchObject({ suggestedName: 'Sprint 01', dueOn: '2026-11-19', freezeDays: 2 });
  });
});

describe('sprintNameOf', () => {
  it('reads a name as the server stores it: one line, whitespace runs collapsed', () => {
    expect(sprintNameOf('  Q4\n  push\t ')).toBe('Q4 push');
    expect(sprintNameOf(' \n ')).toBe('');
  });
});

describe('CreateSprintDialog (#457)', () => {
  async function render(
    overrides: Partial<CreateSprintData> = {},
    write?: () => TrackerWrite<TrackerSprintDto>,
  ) {
    const calls: { slug: string; sprint: { dueOn: string; title: string | null }; key: string }[] = [];
    const close = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideConsoleI18n(),
        { provide: DialogRef, useValue: { close, disableClose: false } },
        {
          provide: DIALOG_DATA,
          useValue: {
            slug: 'team-console',
            sprints: [SPRINT_2],
            suggestedName: 'Sprint 03',
            today: '2026-11-05',
            dueOn: '2026-12-11',
            freezeDays: 2,
            idempotencyKey: 'key-1',
            ...overrides,
          } satisfies CreateSprintData,
        },
        {
          provide: ItemsApi,
          useValue: {
            createSprint: async (
              slug: string,
              sprint: { dueOn: string; title: string | null },
              key: string,
            ) => {
              calls.push({ slug, sprint, key });
              return (
                write?.() ?? {
                  ok: true,
                  replayed: false,
                  value: { ...SPRINT_2, number: 3, title: sprint.title ?? 'Sprint 03', dueOn: sprint.dueOn },
                }
              );
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(CreateSprintDialog);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const name = root.querySelector('[data-testid="sprint-name"]') as HTMLInputElement;
    const type = async (value: string): Promise<void> => {
      name.value = value;
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const submit = async (): Promise<void> => {
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { cancelable: true }),
      );
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    return { fixture, root, name, type, submit, calls, close };
  }

  it('opens with the suggested name, the date and the freeze hint from the given freeze days', async () => {
    const { root, name } = await render({ freezeDays: 3 });
    expect(name.value).toBe('Sprint 03');
    expect(name.maxLength).toBe(64);
    expect(root.textContent).toContain('Спринт начнётся после демо Sprint 02 (27 ноября)');
    // Demo on 11 December with three freeze days: 8–11 December.
    expect(root.textContent).toMatch(/Заморозка перед демо: 8\D+11 дек/);
  });

  it('sends no title for the suggested name, so the server numbers and names it', async () => {
    const { submit, calls, close } = await render();
    await submit();
    expect(calls).toEqual([
      { slug: 'team-console', sprint: { dueOn: '2026-12-11', title: null }, key: 'key-1' },
    ]);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ number: 3, title: 'Sprint 03' }));
  });

  it("sends the owner's name, one line, and the Create button says it", async () => {
    const { root, type, submit, calls } = await render();
    await type('  Checkout\n polish ');
    expect(root.querySelector('[data-testid="sprint-new-ok"]')?.textContent).toContain(
      'Создать Checkout polish',
    );
    await submit();
    expect(calls[0]?.sprint).toEqual({ dueOn: '2026-12-11', title: 'Checkout polish' });
  });

  it('refuses an empty name and one already taken, whatever the case, and sends nothing', async () => {
    const { root, name, type, submit, calls } = await render();
    await type('   ');
    expect(root.textContent).toContain('Напишите название спринта.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    await submit();
    await type('sprint 02');
    expect(root.textContent).toContain('Спринт с таким названием уже есть.');
    await submit();
    expect(calls).toEqual([]);
  });

  it('refuses a demo not after the latest one, naming the sprint as typed', async () => {
    const { root, type, submit, calls } = await render({ dueOn: '2026-11-20' });
    await type('Checkout');
    expect(root.textContent).toContain('Демо Checkout должно быть позже демо Sprint 02 (27 ноября).');
    await submit();
    expect(calls).toEqual([]);
  });

  it('keeps the dialog open on a drop and retries with the same key', async () => {
    let attempt = 0;
    const { root, submit, calls, close } = await render({}, () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, failure: { kind: 'network', field: null, retryAfter: null } }
        : {
            ok: true,
            replayed: true,
            value: { ...SPRINT_2, number: 3, title: 'Sprint 03', dueOn: '2026-12-11' },
          };
    });
    await submit();
    expect(close).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="sprint-new-ok"]')?.textContent).toContain('Повторить');
    await submit();
    expect(calls.map((call) => call.key)).toEqual(['key-1', 'key-1']);
    expect(close).toHaveBeenCalled();
  });

  it('rotates the key when the name changes after a drop, so the edit is a fresh request (#470 item 2)', async () => {
    let attempt = 0;
    const { type, submit, calls } = await render({}, () => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, failure: { kind: 'network', field: null, retryAfter: null } }
        : {
            ok: true,
            replayed: false,
            value: { ...SPRINT_2, number: 3, title: 'Checkout', dueOn: '2026-12-11' },
          };
    });
    await submit();
    await type('Checkout');
    await submit();
    expect(calls[0]).toEqual({
      slug: 'team-console',
      sprint: { dueOn: '2026-12-11', title: null },
      key: 'key-1',
    });
    expect(calls[1]).toEqual({
      slug: 'team-console',
      sprint: { dueOn: '2026-12-11', title: 'Checkout' },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(calls[1]?.key).not.toBe('key-1');
  });

  // Security review on #483: a plain "last body" field would mint a third key here, creating a second sprint A if
  // the first A reached the server despite the dropped response. A body already sent reuses its own key instead.
  it('reuses A’s own key on send A, B, A — never a third key for a body already sent', async () => {
    let attempt = 0;
    const { type, submit, calls } = await render({}, () => {
      attempt += 1;
      // A "drops" (the owner never sees the 201, but the server committed it) — B and the second A succeed.
      return attempt === 1
        ? { ok: false, failure: { kind: 'network', field: null, retryAfter: null } }
        : { ok: true, replayed: false, value: { ...SPRINT_2, number: 3, title: 'Checkout', dueOn: '2026-12-11' } };
    });
    await submit(); // A, key-1, dropped
    await type('Checkout'); // B
    await submit(); // B, a fresh key
    await type('Sprint 03'); // back to A (the suggested name, sent as no title)
    await submit(); // A again
    expect(calls.map((call) => ({ sprint: call.sprint, key: call.key }))).toEqual([
      { sprint: { dueOn: '2026-12-11', title: null }, key: 'key-1' },
      { sprint: { dueOn: '2026-12-11', title: 'Checkout' }, key: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      { sprint: { dueOn: '2026-12-11', title: null }, key: 'key-1' },
    ]);
  });

  it('shows a name the server refused at the name field', async () => {
    const { root, name, type, submit } = await render({}, () => ({
      ok: false,
      failure: { kind: 'invalid', field: 'title', retryAfter: null },
    }));
    await type('Checkout');
    await submit();
    expect(root.textContent).toContain('Консоль не приняла это название.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    await type('Checkout 2');
    expect(root.textContent).not.toContain('Консоль не приняла это название.');
  });
});
