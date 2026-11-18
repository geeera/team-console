import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { RunnerDto } from '@shared/contracts';
import { RunnerCard } from './runner-card';
import { runnerFixture } from './runner.fixture';
import { RunnerProjectsPicker } from './runner-projects-picker';

@Component({
  imports: [RunnerCard],
  template: `<tc-runner-card [runner]="runner()" [minimumVersion]="minimum()">
    <button tc-runner-actions type="button">Act</button>
  </tc-runner-card>`,
})
class Host {
  readonly runner = input.required<RunnerDto>();
  readonly minimum = input<string | null>(null);
}

async function render(runner: RunnerDto, minimum: string | null = null): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('runner', runner);
  fixture.componentRef.setInput('minimum', minimum);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const text = (root: HTMLElement, id: string): string =>
  root.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '';

describe('RunnerCard', () => {
  it('shows name, presence, backend, version, last seen, host and projects', async () => {
    const root = await render(runnerFixture());
    const card = root.querySelector('article');
    expect(card?.getAttribute('aria-labelledby')).toBe(root.querySelector('h3')?.id);
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('Mac');
    expect(text(root, 'runner-presence')).toBe('На связи');
    expect(root.textContent).toContain('Отдельный пользователь macOS');
    expect(text(root, 'runner-version')).toBe('0.2.0');
    expect(root.querySelector('[data-testid="runner-last-seen"]')?.getAttribute('datetime')).toBe(
      '2026-11-11T09:58:00.000Z',
    );
    expect(text(root, 'runner-last-seen')).toMatch(/11 ноября, \d{2}:\d{2}/);
    expect(root.textContent).toContain('mac.local · darwin/arm64');
    expect(text(root, 'runner-projects')).toBe('team-console');
    expect(root.querySelector('[data-testid="runner-behind"]')).toBeNull();
    expect(root.textContent).toContain('Act');
  });

  it('flags a version below the minimum and quotes the minimum', async () => {
    const root = await render(runnerFixture({ version: '0.1.0', belowMinimum: true }), '0.2.0');
    expect(text(root, 'runner-behind')).toBe('Ниже минимальной версии');
    expect(root.textContent).toContain('минимальная 0.2.0 — обновите раннер');
  });

  it('says offline, never seen, suspect and revoked in words', async () => {
    expect(text(await render(runnerFixture({ online: false })), 'runner-presence')).toBe('Не на связи');
    TestBed.resetTestingModule();
    const never = await render(runnerFixture({ online: false, lastSeenAt: null }));
    expect(text(never, 'runner-presence')).toBe('Ещё не выходил на связь');
    expect(never.textContent).toContain('ещё не выходил на связь');
    TestBed.resetTestingModule();
    const suspect = await render(
      runnerFixture({ suspect: { at: '2026-11-11T09:00:00.000Z', reason: 'new-country' } }),
    );
    expect(text(suspect, 'runner-presence')).toBe('Требует проверки');
    expect(text(suspect, 'runner-suspect')).toContain('из новой страны');
    TestBed.resetTestingModule();
    const revoked = await render(
      runnerFixture({ revokedAt: '2026-11-11T09:30:00.000Z', belowMinimum: true, online: false }),
    );
    expect(text(revoked, 'runner-presence')).toBe('Отозван');
    // A revoked runner is not asked to update.
    expect(revoked.querySelector('[data-testid="runner-behind"]')).toBeNull();
  });

  // #571: a pause says why and until when; it outranks online/offline (a paused runner stops polling) but not suspect.
  it('says paused with the reason and the local time it resumes', async () => {
    const until = '2026-11-11T14:30:00.000Z';
    const root = await render(runnerFixture({ online: false, pause: { reason: 'usage-limit', until } }));
    expect(text(root, 'runner-presence')).toBe('Приостановлен');
    const note = root.querySelector('[data-testid="runner-pause"]');
    expect(note?.getAttribute('data-reason')).toBe('usage-limit');
    expect(note?.textContent).toContain('Исчерпан лимит использования Claude');
    expect(note?.querySelector('time')?.getAttribute('datetime')).toBe(until);
    expect(note?.textContent).toMatch(/Продолжит 11 ноября, \d{2}:\d{2}\./);
    TestBed.resetTestingModule();

    const rate = await render(runnerFixture({ pause: { reason: 'rate-limit', until } }));
    expect(text(rate, 'runner-pause')).toContain('ограничивает частоту запросов');
    TestBed.resetTestingModule();

    const suspect = await render(
      runnerFixture({ suspect: { at: '2026-11-11T09:00:00.000Z', reason: 'two-pollers' }, pause: { reason: 'manual', until } }),
    );
    expect(text(suspect, 'runner-presence')).toBe('Требует проверки');
    expect(text(suspect, 'runner-pause')).toContain('Приостановлен на своей машине');
    TestBed.resetTestingModule();

    expect((await render(runnerFixture())).querySelector('[data-testid="runner-pause"]')).toBeNull();
  });

  // #668: an ephemeral GitHub Actions identity is named by its run, never by its stored `actions:<id>`.
  it('names a GitHub Actions identity by its run, and any other runner by its name', async () => {
    const actions = await render(
      runnerFixture({ name: 'actions:9876543210', isolation: 'actions-ephemeral', allowedProjects: ['storify'] }),
    );
    expect(actions.querySelector('h3')?.textContent?.trim()).toBe('GitHub Actions, запуск 9876543210');
    expect(actions.textContent).toContain('GitHub Actions');
    TestBed.resetTestingModule();

    // The name alone never makes a runner look like a run: only the backend does.
    const named = await render(runnerFixture({ name: 'actions:42' }));
    expect(named.querySelector('h3')?.textContent?.trim()).toBe('actions:42');
  });

  // #827: a runner from before enrollers were recorded says so; the claim itself is the page's projected action.
  it('notes a runner with no recorded enroller, worded by whether the caller may claim it', async () => {
    const unrecorded = await render(runnerFixture({ enroller: 'unrecorded' }));
    expect(unrecorded.querySelector('[data-testid="runner-enroller"]')?.getAttribute('data-state')).toBe('unrecorded');
    expect(text(unrecorded, 'runner-enroller')).toContain('подключите его заново');
    TestBed.resetTestingModule();
    expect(text(await render(runnerFixture({ enroller: 'claimable' })), 'runner-enroller')).toContain(
      'Пока вы единственный владелец аккаунта, закрепите его за собой.',
    );
    for (const enroller of ['recorded', 'not-applicable'] as const) {
      TestBed.resetTestingModule();
      expect((await render(runnerFixture({ enroller }))).querySelector('[data-testid="runner-enroller"]')).toBeNull();
    }
  });

  it('says a runner with no projects takes no jobs', async () => {
    expect(text(await render(runnerFixture({ allowedProjects: [] })), 'runner-projects')).toBe(
      'ни одного — раннер не возьмёт задания',
    );
  });

  // #775: `all` says so and lists what it serves now; a project the declared credential cannot run is marked.
  it('shows an all-scope runner with the projects it serves now, and marks one its credential does not fit', async () => {
    const root = await render(
      runnerFixture({
        projectScope: 'all',
        allowedProjects: [],
        capabilities: { local: true, maxConcurrency: 1, accessSources: ['subscription'] },
        servedProjects: [
          { slug: 'team-console', accessSource: 'subscription', fit: true },
          { slug: 'storify', accessSource: 'api_key', fit: false },
        ],
      }),
    );
    expect(text(root, 'runner-scope')).toBe('все проекты аккаунта');
    expect(text(root, 'runner-projects')).toBe('сейчас: team-console, storify');
    const unfit = [...root.querySelectorAll('[data-testid="runner-unfit"]')];
    expect(unfit.map((chip) => chip.getAttribute('data-slug'))).toEqual(['storify']);
    expect(unfit[0]?.textContent?.trim()).toBe('storify не подходит: проект на API-ключе, раннер с подпиской');
    TestBed.resetTestingModule();

    const none = await render(runnerFixture({ projectScope: 'all', allowedProjects: [], servedProjects: [] }));
    expect(text(none, 'runner-projects')).toBe('пока ни одного');
    expect(none.querySelector('[data-testid="runner-unfit"]')).toBeNull();
  });
});

describe('RunnerProjectsPicker', () => {
  @Component({
    imports: [RunnerProjectsPicker],
    template: `<tc-runner-projects-picker legend="Projects" [projects]="projects" [(selected)]="selected" />`,
  })
  class PickerHost {
    projects = [
      { slug: 'team-console', displayName: 'Team Console' },
      { slug: 'storify', displayName: 'Storify' },
    ];
    selected: readonly string[] = ['team-console', 'archived-one'];
  }

  it('ticks and unticks projects, keeping a slug it does not list', async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(PickerHost);
    await fixture.whenStable();
    const boxes = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    boxes[1]?.click();
    boxes[0]?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.selected).toEqual(['archived-one', 'storify']);
  });

  it('says so when the account has no project', async () => {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    const fixture = TestBed.createComponent(PickerHost);
    fixture.componentInstance.projects = [];
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('В аккаунте нет активных проектов.');
  });
});
