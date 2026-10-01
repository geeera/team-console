import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CORE_STATUSES, projectSprintUrl } from '@console/entities/sprint';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import type { SprintDto, SprintIssueDto } from '@shared/contracts';
import { readFileSync } from 'node:fs';
import type { MockInstance } from 'vitest';
import { resolve } from 'node:path';
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
      { number: 45, title: 'chore: pages', url: 'https://github.com/geeera/team-console/pull/45', draft: false, authorTrusted: true },
    ],
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

  async function render() {
    handled.length = 0;
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
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
    ]);
    const qa = root.querySelector('tc-lane[data-status="qa"]') as HTMLElement;
    expect(qa.querySelector('[role="heading"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('На проверке 1');
    expect(qa.querySelector('[data-testid="tier"]')?.textContent).toContain('тяжёлая');
    expect(root.querySelector('tc-lane[data-status="approved"] tc-state-block')?.textContent).toContain('Пусто');
    const pulls = root.querySelector('[data-testid="pulls"]') as HTMLElement;
    expect(pulls.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('2');
    expect(pulls.querySelector('a')?.getAttribute('href')).toBe('https://github.com/geeera/team-console/pull/45');
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
        openPullRequests: [{ number: 8, title, url: null, draft: true, authorTrusted: false }],
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
      expect(block.textContent).toContain('Повтори через минуту.');
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
