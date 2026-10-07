import { BreakpointObserver } from '@angular/cdk/layout';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CORE_STATUSES, projectSprintUrl } from '@console/entities/sprint';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { Icon } from '@console/shared/ui';
import type { RecentRunDto, SprintDto, SprintIssueDto, SprintPullRequestDto, TeamRunDto } from '@shared/contracts';
import { readFileSync } from 'node:fs';
import type { MockInstance } from 'vitest';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import {
  DEFAULT_RETRY_SECONDS,
  MAX_RETRY_SECONDS,
  MIN_RETRY_SECONDS,
  retryDelaySeconds,
  SprintBoard,
  SprintBoardProject,
} from './sprint-board';

// The plugin's own sprint (`backlog list --milestone`, `sprint-metrics`) for real repositories, written by
// libs/worker/read-models/fixtures/golden.py.
const GOLDEN_DIR = resolve(import.meta.dirname, '../../../../../worker/read-models/fixtures');

interface GoldenSprint {
  readonly milestone: { number: number; title: string; dueOn: string } | null;
  readonly issues?: readonly { number: number; status: string | null; kind: string | null; state: 'open' | 'closed' }[];
  readonly byStatus?: Readonly<Record<string, number>>;
  readonly planned?: number;
  readonly shipped?: number;
  readonly carriedOver?: number;
}

function goldenSprint(name: string): GoldenSprint {
  const expected = JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${name}.expected.json`), 'utf8')) as {
    sprint: GoldenSprint;
  };
  return expected.sprint;
}

const TC: SprintBoardProject = { slug: 'team-console', name: 'Team Console' };

function issue(number: number, overrides: Partial<SprintIssueDto> = {}): SprintIssueDto {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/geeera/team-console/issues/${number}`,
    state: 'open',
    status: 'in-progress',
    tier: 'standard',
    kind: 'feature',
    authorTrusted: true,
    ...overrides,
  };
}

function sprint(overrides: Partial<SprintDto> = {}): SprintDto {
  return {
    milestone: {
      number: 1,
      title: 'Sprint 01',
      dueOn: '2026-10-16',
      url: 'https://github.com/geeera/team-console/milestone/1',
    },
    issues: [issue(18), issue(14, { status: 'qa', tier: 'heavy' }), issue(3, { status: 'done', state: 'closed' })],
    byStatus: { 'in-progress': 1, qa: 1, done: 1 },
    planned: 3,
    shipped: 1,
    carriedOver: 2,
    byTier: {},
    openPullRequests: [
      { number: 45, title: 'chore: pages', url: 'https://github.com/geeera/team-console/pull/45', draft: false, authorTrusted: true, ci: 'failure' },
    ],
    team: { state: 'running', runLogUrl: null, recentRuns: [] },
    ...overrides,
  };
}

@Component({
  imports: [SprintBoard],
  template: `<tc-sprint-board [project]="project()" />`,
})
class Host {
  readonly project = signal<SprintBoardProject>(TC);
}

describe('SprintBoard', () => {
  let http: HttpTestingController;
  const handled: unknown[] = [];

  async function tick(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((done) => setTimeout(done, 0));
    }
  }

  /** `phone`: the kit's lanes see the phone breakpoint and show the lane switcher. */
  async function render(phone = false) {
    handled.length = 0;
    const breakpoints = phone
      ? [
          {
            provide: BreakpointObserver,
            useValue: { isMatched: () => true, observe: () => of({ matches: true, breakpoints: {} }) },
          },
        ]
      : [];
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        ...breakpoints,
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: ErrorHandler, useValue: { handleError: (error: unknown) => handled.push(error) } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const settle = async (): Promise<void> => {
      await tick();
      await fixture.whenStable();
    };
    const lanes = () =>
      Object.fromEntries(
        [...root.querySelectorAll<HTMLElement>('tc-lanes tc-lane')].map((lane) => [
          lane.getAttribute('data-status'),
          lane.querySelectorAll('tc-list-row').length,
        ]),
      );
    const text = (selector: string) => root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    return { fixture, root, settle, lanes, text };
  }

  afterEach(() => http.verify());

  it.each(['team-console', 'storify', 'edge-cases'])(
    'counts every lane exactly as the plugin counts the %s sprint',
    async (name) => {
      const golden = goldenSprint(name);
      const goldenIssues = golden.issues ?? [];
      const { settle, lanes, text } = await render();
      http.expectOne(projectSprintUrl(TC.slug)).flush(
        sprint({
          milestone:
            golden.milestone === null
              ? null
              : { ...golden.milestone, url: `https://github.com/o/r/milestone/${golden.milestone.number}` },
          issues: goldenIssues.map((item) => issue(item.number, { status: item.status, kind: item.kind, state: item.state })),
          byStatus: golden.byStatus ?? {},
          planned: golden.planned ?? 0,
          shipped: golden.shipped ?? 0,
          carriedOver: golden.carriedOver ?? 0,
        }),
      );
      await settle();

      const shown = lanes();
      const expected: Record<string, number> = Object.fromEntries(CORE_STATUSES.map((status) => [status, 0]));
      Object.assign(expected, golden.byStatus);
      expect(shown).toEqual(expected);
      expect(Object.values(shown).reduce((sum, n) => sum + n, 0)).toBe(goldenIssues.length);
      expect(text('[data-testid="stats"]')).toContain(`${golden.shipped} из ${golden.planned}`);
    },
  );

  it('#219: marks an issue whose request waits for the PM and offers Ask the PM by the title', async () => {
    const { root, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(
      sprint({
        issues: [
          issue(18, {
            request: {
              kind: 'sprint',
              target: 'next',
              state: 'pending',
              requestedAt: '2026-10-06T09:00:00Z',
              url: 'https://github.com/geeera/team-console/issues/18#issuecomment-1',
              handledAt: null,
            },
          }),
          issue(14, { status: 'qa' }),
        ],
      }),
    );
    await settle();
    const pending = root.querySelector('tc-list-row[data-number="18"] [data-testid="request-pending"]');
    expect(pending?.textContent?.trim()).toBe('ждёт PM');
    expect(root.querySelector('tc-list-row[data-number="14"] [data-testid="request-pending"]')).toBeNull();
    const ask = root.querySelector('[data-testid="board-ask"]');
    expect(ask?.getAttribute('aria-label')).toBe('Попросить PM о задаче: выбрать задачу');
    expect(ask?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('shows the sprint, its demo date and numbers, the lanes with tiers and the open pull requests', async () => {
    const { root, settle, text } = await render();
    expect(root.querySelector('[data-testid="loading"]')?.getAttribute('role')).toBe('status');

    http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
    await settle();

    expect(root.querySelector('[data-testid="loading"]')).toBeNull();
    expect(text('h2')).toBe('Sprint 01');
    expect(text('[data-testid="demo"]')).toMatch(/^Демо 16 октября/);
    const stats = [...root.querySelectorAll('[data-testid="stats"] div[tc-stat]')].map((stat) => [
      stat.querySelector('dt')?.textContent?.trim(),
      stat.querySelector('dd')?.textContent?.trim(),
    ]);
    expect(stats).toEqual([
      ['Готово', '1 из 3'],
      ['Ещё открыто', '2'],
      ['Открытые PR', '1'],
      ['CI', 'Не пройден: 1'],
      ['Прогоны', 'В работе'],
    ]);
    const qa = root.querySelector('tc-lane[data-status="qa"]') as HTMLElement;
    expect(qa.querySelector('[role="heading"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Проверка 1');
    expect(qa.querySelector('[data-testid="tier"]')?.getAttribute('data-tier')).toBe('heavy');
    expect(qa.querySelector('[data-testid="tier"] .tc-sr-only')?.textContent?.trim()).toBe('Сложность: тяжёлая');
    expect(root.querySelector('tc-lane[data-status="approved"] tc-state-block')?.textContent).toContain('Пусто');
    const pulls = root.querySelector('[data-testid="pulls"]') as HTMLElement;
    expect(pulls.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('2');
    expect(pulls.querySelector('a')?.getAttribute('href')).toBe('https://github.com/geeera/team-console/pull/45');
  });

  describe('CI per open pull request (#131)', () => {
    const pr = (number: number, ci: SprintPullRequestDto['ci']): SprintPullRequestDto => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/geeera/team-console/pull/${number}`,
      draft: false,
      authorTrusted: true,
      ci,
    });

    it("shows each row's state with an icon and words inside its link", async () => {
      const { root, settle } = await render();
      http.expectOne(projectSprintUrl(TC.slug)).flush(
        sprint({
          openPullRequests: [pr(5, 'success'), pr(4, 'failure'), pr(3, 'pending'), pr(2, 'none'), pr(1, 'unknown')],
        }),
      );
      await settle();

      const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="pulls"] tc-list-row')];
      const shown = rows.map((row) => {
        const chip = row.querySelector('[data-testid="ci"]') as HTMLElement;
        return [
          row.getAttribute('data-number'),
          chip.getAttribute('data-ci'),
          chip.querySelector('tc-icon')?.getAttribute('aria-hidden'),
          chip.textContent?.trim(),
          row.querySelector('a')?.contains(chip),
        ];
      });
      expect(shown).toEqual([
        ['5', 'success', 'true', 'CI пройден', true],
        ['4', 'failure', 'true', 'CI не пройден', true],
        ['3', 'pending', 'true', 'CI идёт', true],
        ['2', 'none', 'true', 'Проверок нет', true],
        ['1', 'unknown', 'true', 'CI неизвестен', true],
      ]);
      // Each state has its own glyph, so it reads without colour.
      const glyphs = rows.map((row) => row.querySelector('[data-testid="ci"] tc-icon path')?.getAttribute('d'));
      expect(new Set(glyphs).size).toBe(5);
    });

    it.each([
      [['success', 'pending', 'failure', 'failure'], 'failure', 'Не пройден: 2', 'Failing: 2'],
      [['success', 'pending', 'unknown'], 'pending', 'Идёт: 1', 'Running: 1'],
      [['success', 'unknown', 'none'], 'unknown', 'Неизвестно: 1', 'Unknown: 1'],
      [['success', 'success', 'none'], 'success', 'Пройден: 2', 'Passing: 2'],
      [['none'], 'none', 'Проверок нет', 'No checks'],
      [[], 'empty', 'Нет открытых PR', 'No open PRs'],
    ] as const)('the CI tile for %j says %s in both languages', async (states, state, ru, en) => {
      const { root, fixture, settle } = await render();
      http
        .expectOne(projectSprintUrl(TC.slug))
        .flush(sprint({ openPullRequests: states.map((ci, index) => pr(index + 1, ci)) }));
      await settle();

      const tile = root.querySelector('[data-testid="ci-stat"]') as HTMLElement;
      expect(tile.getAttribute('data-ci')).toBe(state);
      expect(tile.querySelector('dt')?.textContent?.trim()).toBe('CI');
      expect(tile.querySelector('dd')?.textContent?.trim()).toBe(ru);
      expect(tile.querySelector('dd tc-icon')?.getAttribute('aria-hidden')).toBe('true');

      TestBed.inject(TranslocoService).setActiveLang('en');
      await settle();
      fixture.detectChanges();
      expect(tile.querySelector('dd')?.textContent?.trim()).toBe(en);
    });
  });

  describe('team run state (#132)', () => {
    const LOG = 'https://github.com/geeera/team-console/issues/22';
    const run = (
      state: RecentRunDto['state'],
      slot: RecentRunDto['slot'],
      slotName = `slot-${slot ?? 'x'}`,
      at = '2026-10-04T15:45:00Z',
    ): RecentRunDto => ({
      slot,
      slotName,
      state,
      at,
    });
    const team = (overrides: Partial<TeamRunDto> = {}): TeamRunDto => ({
      state: 'running',
      runLogUrl: LOG,
      recentRuns: [],
      ...overrides,
    });

    it.each([
      ['running', 'В работе', 'Running'],
      ['paused', 'На паузе', 'Paused'],
      ['failing', 'Сбой', 'Failing'],
      ['unknown', 'Неизвестно', 'Unknown'],
    ] as const)(
      'the Run log tile says %s with an icon and words in both languages',
      async (state, ru, en) => {
        const { root, fixture, settle } = await render();
        http.expectOne(projectSprintUrl(TC.slug)).flush(sprint({ team: team({ state }) }));
        await settle();

        const tile = root.querySelector('[data-testid="team-stat"]') as HTMLElement;
        expect(tile.getAttribute('data-team')).toBe(state);
        expect(tile.querySelector('dt')?.textContent?.trim()).toBe('Прогоны');
        expect(tile.querySelector('dd')?.textContent?.trim()).toBe(ru);
        expect(tile.querySelector('dd tc-icon')?.getAttribute('aria-hidden')).toBe('true');
        expect(tile.classList.contains('tc-stat--danger')).toBe(state === 'failing');

        TestBed.inject(TranslocoService).setActiveLang('en');
        await settle();
        fixture.detectChanges();
        expect(tile.querySelector('dt')?.textContent?.trim()).toBe('Run log');
        expect(tile.querySelector('dd')?.textContent?.trim()).toBe(en);
      },
    );

    it('lists the last runs with slot, time and state, and links the run log', async () => {
      const { root, settle } = await render();
      http.expectOne(projectSprintUrl(TC.slug)).flush(
        sprint({
          team: team({
            recentRuns: [
              run('running', 'dev'),
              run('finished', 'pm'),
              run('unknown', 'dev'),
              run('failed', 'qa'),
              run('finished', null, 'slot-nightly <b>x</b>'),
            ],
          }),
        }),
      );
      await settle();

      const lane = root.querySelector('[data-testid="runs"]') as HTMLElement;
      expect(lane.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('2');
      expect(lane.querySelector('tc-list')?.getAttribute('aria-label')).toBe('Последние прогоны');
      const rows = [...lane.querySelectorAll<HTMLElement>('[data-testid="run"]')].map((row) => [
        row.querySelector('[tc-row-title]')?.textContent?.trim(),
        row.querySelector('[data-testid="run-state"]')?.textContent?.trim(),
        row.querySelector('[data-testid="run-state"] tc-icon')?.getAttribute('aria-hidden'),
        row.querySelector('time')?.getAttribute('datetime'),
      ]);
      expect(rows).toEqual([
        ['Разработка', 'Идёт', 'true', '2026-10-04T15:45:00Z'],
        ['Планирование', 'Завершён', 'true', '2026-10-04T15:45:00Z'],
        ['Разработка', 'Неизвестно', 'true', '2026-10-04T15:45:00Z'],
        ['Проверка (QA)', 'Сбой', 'true', '2026-10-04T15:45:00Z'],
        // A slot the console has no name for: as written, plain text.
        ['slot-nightly <b>x</b>', 'Завершён', 'true', '2026-10-04T15:45:00Z'],
      ]);
      expect(lane.querySelector('b')).toBeNull();
      expect(lane.querySelector('time')?.textContent).toMatch(/4 октября/);
      // Each state has its own glyph.
      const glyphs = [...lane.querySelectorAll('[data-testid="run-state"] tc-icon path')].map((path) =>
        path.getAttribute('d'),
      );
      expect(new Set(glyphs).size).toBe(4);
      const link = lane.querySelector('[data-testid="run-log-link"] a') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(LOG);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'Весь журнал прогонов (откроется на GitHub)',
      );
    });

    it('says when there are no runs yet and still links the run log', async () => {
      const { root, settle } = await render();
      http.expectOne(projectSprintUrl(TC.slug)).flush(sprint({ team: team() }));
      await settle();
      expect(root.querySelector('[data-testid="runs-empty"]')?.textContent).toContain('Прогонов пока нет');
      expect(root.querySelector('[data-testid="run-log-link"]')).not.toBeNull();
    });

    it('without a run log yet (team running) says no runs yet and shows no link', async () => {
      const { root, settle } = await render();
      http
        .expectOne(projectSprintUrl(TC.slug))
        .flush(sprint({ team: team({ state: 'running', runLogUrl: null }) }));
      await settle();
      expect(root.querySelector('[data-testid="runs-empty"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="runs-unavailable"]')).toBeNull();
      expect(root.querySelector('[data-testid="runs"] tc-list')).toBeNull();
    });

    it('a run log it could not read or trust says unavailable with a question mark, never "no runs yet" (#201)', async () => {
      const { root, fixture, settle } = await render();
      http
        .expectOne(projectSprintUrl(TC.slug))
        .flush(sprint({ team: team({ state: 'unknown', runLogUrl: null }) }));
      await settle();

      const lane = root.querySelector('[data-testid="runs"]') as HTMLElement;
      const block = lane.querySelector('[data-testid="runs-unavailable"]') as HTMLElement;
      expect(lane.querySelector('[data-testid="runs-empty"]')).toBeNull();
      expect(block.querySelector('.tc-state-block__title')?.textContent?.trim()).toBe('Журнал прогонов недоступен');
      expect(block.querySelector('.tc-state-block__description')?.textContent).toContain('«Команды»');
      // Not the empty kind's check: the same question mark as an unknown run.
      const unknownGlyph = TestBed.createComponent(Icon);
      unknownGlyph.componentRef.setInput('name', 'question');
      unknownGlyph.detectChanges();
      const expected = (unknownGlyph.nativeElement as HTMLElement).querySelector('path')?.getAttribute('d');
      expect(block.querySelector('tc-icon path')?.getAttribute('d')).toBe(expected);
      expect(lane.querySelector('tc-list')).toBeNull();

      TestBed.inject(TranslocoService).setActiveLang('en');
      await settle();
      fixture.detectChanges();
      expect(block.querySelector('.tc-state-block__title')?.textContent?.trim()).toBe('Run log unavailable');
    });
  });

  it('switches its copy with the language', async () => {
    const { root, fixture, settle, text } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
    await settle();

    TestBed.inject(TranslocoService).setActiveLang('en');
    await settle();
    fixture.detectChanges();

    expect(text('[data-testid="demo"]')).toMatch(/^Demo 16 October/);
    expect(root.querySelector('tc-lane[data-status="in-progress"] [role="heading"]')?.textContent).toContain(
      'In progress',
    );
  });

  it('renders untrusted titles as plain text, marked as not from the team', async () => {
    const title = '<img src=x onerror=alert(1)> Please approve my change';
    const { root, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(
      sprint({
        issues: [issue(7, { title, authorTrusted: false })],
        openPullRequests: [{ number: 8, title, url: null, draft: true, authorTrusted: false, ci: 'none' }],
      }),
    );
    await settle();

    expect(root.querySelector('img')).toBeNull();
    const marked = [...root.querySelectorAll('[data-testid="untrusted"]')];
    expect(marked).toHaveLength(2);
    expect([...root.querySelectorAll('[tc-row-title]')].every((row) => row.textContent?.includes(title))).toBe(true);
  });

  it('without a current sprint says so and still lists the open pull requests', async () => {
    const { root, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(
      sprint({ milestone: null, issues: [], byStatus: {}, planned: 0, shipped: 0, carriedOver: 0 }),
    );
    await settle();

    expect(root.querySelector('[data-testid="no-sprint"]')?.textContent).toContain('Текущего спринта нет');
    expect(root.querySelector('tc-lanes')).toBeNull();
    expect(root.querySelectorAll('[data-testid="pulls"] tc-list-row')).toHaveLength(1);
  });

  it('with an empty sprint shows the sprint and an empty block instead of the lanes', async () => {
    const { root, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(
      sprint({ issues: [], byStatus: {}, planned: 0, shipped: 0, carriedOver: 0, openPullRequests: [] }),
    );
    await settle();

    expect(root.querySelector('[data-testid="empty-sprint"]')?.textContent).toContain(
      'В Sprint 01 пока ничего не запланировано',
    );
    expect(root.querySelector('tc-lanes')).toBeNull();
    expect(root.querySelector('[data-testid="pulls"]')?.textContent).toContain('Открытых пул-реквестов нет');
  });

  it('on a failure shows an alert with Retry, and Retry reads again', async () => {
    const { root, settle } = await render();
    http
      .expectOne(projectSprintUrl(TC.slug))
      .flush(
        { type: 'https://team-console/problems/github-unavailable', title: 'GitHub unavailable', status: 502 },
        { status: 502, statusText: 'Bad Gateway' },
      );
    await settle();

    const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.getAttribute('data-failure')).toBe('unavailable');
    expect(block.textContent).toContain('Не удалось загрузить доску');

    (block.querySelector('button') as HTMLButtonElement).click();
    await settle();
    http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
    await settle();

    expect(root.querySelector('[data-testid="load-error"]')).toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('Sprint 01');
  });

  describe('on 429', () => {
    const RATE_LIMITED = {
      type: 'https://team-console/problems/github-rate-limit',
      title: 'Rate limited',
      status: 429,
    };
    const SECOND = 1000;
    // Angular and the test settle on 0 ms timers; the board's retry is the only one of a second or more.
    let setTimeoutSpy: MockInstance<typeof setTimeout>;
    let clearTimeoutSpy: MockInstance<typeof clearTimeout>;

    beforeEach(() => {
      setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    });
    afterEach(() => vi.restoreAllMocks());

    function retryTimers(): { readonly delay: number; readonly fire: () => void; readonly handle: unknown }[] {
      return setTimeoutSpy.mock.calls.flatMap(([callback, delay], index) =>
        typeof delay === 'number' && delay >= SECOND && typeof callback === 'function'
          ? [{ delay, fire: () => (callback as () => void)(), handle: setTimeoutSpy.mock.results[index]?.value }]
          : [],
      );
    }

    function rateLimit(retryAfter: string | null): void {
      const headers: Record<string, string> = retryAfter === null ? {} : { 'Retry-After': retryAfter };
      http
        .expectOne(projectSprintUrl(TC.slug))
        .flush(RATE_LIMITED, { status: 429, statusText: 'Too Many Requests', headers });
    }

    function pending(): number {
      return http.match(projectSprintUrl(TC.slug)).length;
    }

    /** The delay is computed from `Date.now()`, so it can be a few milliseconds short of the full wait. */
    function expectDelay(delay: number, seconds: number): void {
      expect(delay).toBeGreaterThan(seconds * SECOND - SECOND);
      expect(delay).toBeLessThanOrEqual(seconds * SECOND);
    }

    it('says when it asks again, and does so by itself after Retry-After', async () => {
      const { root, settle } = await render();
      rateLimit('42');
      await settle();

      const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
      expect(block.getAttribute('data-failure')).toBe('rate-limited');
      expect(block.textContent).toContain('GitHub просит подождать');
      expect(block.textContent).toMatch(/Доска сама попробует снова в \d{2}:\d{2}/);
      expect(pending()).toBe(0);
      const timers = retryTimers();
      expect(timers).toHaveLength(1);
      expectDelay(timers[0]?.delay ?? 0, 42);

      timers[0]?.fire();
      await settle();
      http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
      await settle();
      expect(root.querySelector('h2')?.textContent).toBe('Sprint 01');
    });

    it('two Retry-After: 0 answers give exactly one automatic retry, at the default wait, then only Retry', async () => {
      const { root, settle } = await render();
      rateLimit('0');
      await settle();

      // 0 is not a usable wait: nothing is asked at once, the one retry waits the default.
      expect(pending()).toBe(0);
      expect(retryTimers()).toHaveLength(1);
      const [first] = retryTimers();
      expect(first?.delay).toBeGreaterThanOrEqual(MIN_RETRY_SECONDS * SECOND);
      expectDelay(first?.delay ?? 0, DEFAULT_RETRY_SECONDS);

      first?.fire();
      await settle();
      rateLimit('0');
      await settle();

      expect(retryTimers()).toHaveLength(1);
      expect(pending()).toBe(0);
      const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
      expect(block.getAttribute('data-failure')).toBe('rate-limited');
      expect(block.textContent).toContain('Повторите через минуту.');
      expect(block.textContent).not.toContain('сама попробует');

      // The owner's Retry asks once more and may earn one more automatic retry.
      (block.querySelector('button') as HTMLButtonElement).click();
      await settle();
      rateLimit('10');
      await settle();
      expect(retryTimers()).toHaveLength(2);
      expectDelay(retryTimers()[1]?.delay ?? 0, 10);
    });

    it('clamps a huge Retry-After to the ceiling instead of overflowing the timer', async () => {
      const { settle } = await render();
      rateLimit('99999999999');
      await settle();

      expect(pending()).toBe(0);
      const timers = retryTimers();
      expect(timers).toHaveLength(1);
      expectDelay(timers[0]?.delay ?? 0, MAX_RETRY_SECONDS);
    });

    it('drops its retry timer when the board is destroyed', async () => {
      const { fixture, settle } = await render();
      rateLimit('42');
      await settle();
      const [timer] = retryTimers();

      fixture.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer?.handle);
    });
  });

  it.each([
    [null, DEFAULT_RETRY_SECONDS],
    [0, DEFAULT_RETRY_SECONDS],
    [-3, DEFAULT_RETRY_SECONDS],
    [Number.NaN, DEFAULT_RETRY_SECONDS],
    [Number.POSITIVE_INFINITY, DEFAULT_RETRY_SECONDS],
    [1, MIN_RETRY_SECONDS],
    [42, 42],
    [99999999999, MAX_RETRY_SECONDS],
  ])('waits a bounded time for Retry-After %s: %s s', (retryAfter, seconds) => {
    expect(retryDelaySeconds(retryAfter)).toBe(seconds);
  });

  it.each([
    ['not-installed', 404, { type: 'https://team-console/problems/github-app-not-installed', title: 'x', status: 404 }, 'Приложение консоли не установлено'],
    ['offline', 0, null, 'Нет соединения'],
  ] as const)('tells a %s failure apart', async (failure, status, body, copy) => {
    const { root, settle } = await render();
    const request = http.expectOne(projectSprintUrl(TC.slug));
    if (status === 0) {
      request.error(new ProgressEvent('error'), { status: 0 });
    } else {
      request.flush(body, { status, statusText: 'x' });
    }
    await settle();

    const block = root.querySelector('[data-testid="load-error"]') as HTMLElement;
    expect(block.getAttribute('data-failure')).toBe(failure);
    expect(block.textContent).toContain(copy);
  });

  it('shows nothing of a response with the wrong shape', async () => {
    const { root, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush({ issues: '<b>x</b>' });
    await settle();

    expect(root.querySelector('[data-testid="load-error"]')?.getAttribute('data-failure')).toBe('unavailable');
    expect(root.querySelector('tc-lanes')).toBeNull();
    expect(handled).toEqual([]);
  });

  it('explains the tier icons once, under the numbers, with the existing tier copy', async () => {
    const { root, settle, text } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
    await settle();

    const legend = root.querySelector('[data-testid="tier-legend"]') as HTMLElement;
    expect(legend.previousElementSibling?.getAttribute('data-testid')).toBe('stats');
    expect(text('[data-testid="tier-legend"]')).toBe('Сложность: лёгкая средняя тяжёлая');
    expect([...legend.querySelectorAll('[data-tier]')].map((icon) => icon.getAttribute('data-tier'))).toEqual([
      'light',
      'standard',
      'heavy',
    ]);
  });

  describe('on the phone', () => {
    const tabs = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => [
        tab.textContent?.replace(/\s+/g, ' ').trim(),
        tab.getAttribute('aria-selected'),
      ]);
    const shown = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>('tc-lanes tc-lane')]
        .filter((lane) => !lane.hidden)
        .map((lane) => lane.getAttribute('data-status'));

    it('switches lanes with a named tab list and opens on the first lane with issues', async () => {
      const { root, settle } = await render(true);
      http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
      await settle();

      expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Задачи спринта по статусам');
      expect(tabs(root)).toEqual([
        ['Одобрено 0', 'false'],
        ['В работе 1', 'true'],
        ['Проверка 1', 'false'],
        ['Готово 1', 'false'],
      ]);
      expect(shown(root)).toEqual(['in-progress']);
      // The open pull requests are not one of the lanes: always shown, under the selected lane.
      expect((root.querySelector('[data-testid="pulls"]') as HTMLElement).hidden).toBe(false);
    });

    it('keeps the lane the owner picked across a refresh, and falls back when it is gone', async () => {
      const blocked = sprint({ issues: [issue(18), issue(20, { status: 'blocked' })], byStatus: {} });
      const { root, fixture, settle } = await render(true);
      http.expectOne(projectSprintUrl(TC.slug)).flush(blocked);
      await settle();
      const board = fixture.debugElement.query(By.directive(SprintBoard)).componentInstance as SprintBoard;
      const pick = async (name: string) => {
        const tab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((each) =>
          each.textContent?.includes(name),
        );
        tab?.click();
        await settle();
      };
      const refresh = async (body: SprintDto) => {
        void board.reload();
        await settle();
        expect(root.querySelector('tc-lanes')).toBeNull();
        http.expectOne(projectSprintUrl(TC.slug)).flush(body);
        await settle();
      };

      await pick('Блокеры');
      expect(shown(root)).toEqual(['blocked']);
      await refresh(blocked);
      expect(shown(root)).toEqual(['blocked']);

      await refresh(sprint({ issues: [issue(18)], byStatus: {} }));
      expect(shown(root)).toEqual(['in-progress']);
    });
  });

  it('reads the new project when the slug changes', async () => {
    const { fixture, settle } = await render();
    http.expectOne(projectSprintUrl(TC.slug)).flush(sprint());
    await settle();

    fixture.componentInstance.project.set({ slug: 'storify', name: 'storify' });
    await settle();

    http.expectOne(projectSprintUrl('storify')).flush(sprint());
    await settle();
  });
});
