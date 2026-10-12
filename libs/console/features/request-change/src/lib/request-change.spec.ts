import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TeamStatusStore } from '@console/entities/team-run';
import { provideConsoleI18n } from '@console/shared/i18n';
import type { IssueRequestDto, OwnerRequestResponse, TeamStatusDto } from '@shared/contracts';
import { RequestChange } from './request-change';
import { issueRequestUrl, requestIssuesUrl } from './request-change.client';
import { initialChoiceOf, pickQueue, pickSprint, requestOf, whereOf } from './request-form';
import { matchesQuery } from './request-picker-dialog';

const TARGET = { slug: 'tc', name: 'Team Console' };
const NOW = Date.parse('2026-10-06T09:00:00.000Z');

const STATUS: TeamStatusDto = {
  state: 'running',
  pausedAt: null,
  runLogUrl: null,
  ownerConnected: true,
  environment: 'local',
  snooze: { snoozed: false },
  checkedAt: '2026-10-06T09:00:00.000Z',
  sprint: null,
  progress: null,
  calendar: null,
  pendingRequests: 0,
  slots: (['pm', 'dev', 'qa'] as const).map((slot) => ({
    slot,
    setup: 'missing',
    secrets: { token: 't', routine: 'r' },
    lastRun: null,
    lock: null,
  })),
};

const ISSUE: IssueRequestDto = {
  number: 7,
  title: 'Board filters',
  state: 'open',
  milestone: 'Sprint 04',
  current: { number: 4, title: 'Sprint 04', due: '2026-10-14' },
  next: { number: 5, title: 'Sprint 05', due: '2026-10-28' },
  freezeNow: false,
  request: null,
};

const RESPONSE: OwnerRequestResponse = {
  commentId: 5_000_001,
  url: 'https://github.com/geeera/team-console/issues/7#issuecomment-5000001',
  requestedAt: '2026-10-06T09:00:01.000Z',
  replayed: false,
};

function overlay(): HTMLElement {
  return document.querySelector('.cdk-overlay-container') as HTMLElement;
}

function dialog(): HTMLElement | null {
  return overlay()?.querySelector('tc-sheet-container') ?? null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const text = (element: Element | null | undefined): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('request form rules', () => {
  it('knows where the issue is', () => {
    expect(whereOf(ISSUE)).toBe('current');
    expect(whereOf({ ...ISSUE, milestone: 'Sprint 05' })).toBe('next');
    expect(whereOf({ ...ISSUE, milestone: null })).toBe('backlog');
    expect(whereOf({ ...ISSUE, milestone: 'Someday' })).toBeNull();
  });

  it('holds one request at a time: a sprint move clears the queue move and the other way round', () => {
    expect(requestOf(ISSUE, initialChoiceOf(ISSUE))).toBeNull();
    expect(requestOf(ISSUE, pickSprint('next'))).toEqual({ kind: 'sprint', target: 'next' });
    expect(requestOf(ISSUE, pickQueue(ISSUE, 'up'))).toEqual({ kind: 'priority', direction: 'up' });
    expect(pickQueue(ISSUE, 'down').sprint).toBe('current');
    expect(pickSprint('backlog').queue).toBe('keep');
  });

  it('finds an issue by number or title', () => {
    const row = { number: 42, title: 'Board Filters', request: null };
    expect(matchesQuery(row, '#42')).toBe(true);
    expect(matchesQuery(row, '4')).toBe(true);
    expect(matchesQuery(row, 'filters')).toBe(true);
    expect(matchesQuery(row, 'search')).toBe(false);
  });
});

describe('RequestChange', () => {
  let requests: RequestChange;
  let http: HttpTestingController;
  let status: TeamStatusStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideConsoleI18n()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    requests = TestBed.inject(RequestChange);
    requests.now = () => NOW;
    status = TestBed.inject(TeamStatusStore);
    status.slug.set('tc');
    status.status.set(STATUS);
    vi.spyOn(status, 'refresh').mockResolvedValue(undefined);
  });

  afterEach(() => {
    http.verify();
    overlay()?.remove();
  });

  function press(selector: string): void {
    const element = dialog()?.querySelector<HTMLElement>(selector);
    if (element === null || element === undefined) {
      throw new Error(`no ${selector} in the dialog`);
    }
    element.click();
  }

  async function openForm(issue: IssueRequestDto = ISSUE): Promise<{ pending: Promise<unknown> }> {
    const pending = requests.ask(TARGET, 7);
    await settle();
    http.expectOne(issueRequestUrl('tc', 7)).flush(issue);
    await settle();
    return { pending };
  }

  it('picks an issue from the list, then sends one sprint request with the milestone the form showed', async () => {
    const pending = requests.ask(TARGET);
    await settle();
    expect(text(dialog()?.querySelector('.tc-sheet__title'))).toBe('О какой задаче попросить?');
    http.expectOne(requestIssuesUrl('tc')).flush({
      items: [
        { number: 7, title: 'Board filters', request: null },
        {
          number: 8,
          title: 'Backlog idea',
          request: {
            kind: 'priority',
            direction: 'up',
            state: 'pending',
            requestedAt: '2026-10-06T08:00:00Z',
            url: 'https://github.com/x',
            handledAt: null,
          },
        },
      ],
    });
    await settle();
    expect(text(dialog()?.querySelector('[data-number="8"]'))).toContain('ждёт PM');
    press('[data-number="7"] button');
    await settle();
    http.expectOne(issueRequestUrl('tc', 7)).flush(ISSUE);
    await settle();

    const form = dialog() as HTMLElement;
    expect(text(form.querySelector('.tc-sheet__title'))).toBe('#7 Board filters');
    expect(text(form.querySelector('[data-testid="request-now"]'))).toBe('Сейчас: Sprint 04');
    expect(text(form.querySelector('[data-testid="request-ok"]'))).toBe('Пока ничего не выбрано');
    expect(text(form)).toContain('PM прочитает');
    press('[data-testid="request-sprint-next"]');
    await settle();
    expect(text(form.querySelector('[data-testid="request-diff"]'))).toBe('Просьба: перенести в Sprint 05.');
    press('[data-testid="request-ok"]');
    await settle();

    const post = http.expectOne(issueRequestUrl('tc', 7));
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      request: { kind: 'sprint', target: 'next' },
      expectedMilestone: 'Sprint 04',
    });
    post.flush(RESPONSE, { status: 201, statusText: 'Created' });
    await expect(pending).resolves.toMatchObject({
      tone: 'positive',
      verb: 'Просьба по #7 записана',
      detail: 'PM прочитает её на ближайшем планировании и ответит в задаче.',
    });
  });

  it('disables Next when no next sprint exists', async () => {
    const { pending } = await openForm({ ...ISSUE, next: null });
    const next = dialog()?.querySelector<HTMLInputElement>('[data-testid="request-sprint-next"]');
    expect(next?.disabled).toBe(true);
    expect(text(next?.closest('label'))).toContain('Следующий: ещё не создан');
    press('.tc-sheet__foot button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('disables Current when there is no current sprint (#272)', async () => {
    const { pending } = await openForm({ ...ISSUE, milestone: null, current: null, next: null });
    const current = dialog()?.querySelector<HTMLInputElement>('[data-testid="request-sprint-current"]');
    expect(current?.disabled).toBe(true);
    expect(text(current?.closest('label'))).toBe('Текущий: —');
    expect(
      dialog()?.querySelector<HTMLInputElement>('[data-testid="request-sprint-backlog"]')?.disabled,
    ).toBe(false);
    press('.tc-sheet__foot button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('shows the pending request and that a new one replaces it', async () => {
    const { pending } = await openForm({
      ...ISSUE,
      request: {
        kind: 'sprint',
        target: 'backlog',
        state: 'pending',
        requestedAt: '2026-10-06T08:00:00Z',
        url: 'https://github.com/x',
        handledAt: null,
      },
    });
    expect(text(dialog()?.querySelector('[data-testid="request-previous"]'))).toMatch(
      /^Уже ждёт PM: убрать в бэклог \(.+\)\. Новая просьба заменит её\.$/,
    );
    press('.tc-sheet__foot button[type=button]');
    await pending;
  });

  it('on issue-changed writes nothing more, re-reads the issue and shows the live sprint', async () => {
    const { pending } = await openForm();
    press('[data-testid="request-queue-up"]');
    await settle();
    press('[data-testid="request-ok"]');
    await settle();
    http.expectOne(issueRequestUrl('tc', 7)).flush(
      {
        type: 'https://team-console/problems/issue-changed',
        title: 'Changed',
        status: 409,
        milestone: 'Sprint 05',
      },
      { status: 409, statusText: 'Conflict', headers: { 'Content-Type': 'application/problem+json' } },
    );
    await settle();
    http.expectOne(issueRequestUrl('tc', 7)).flush({ ...ISSUE, milestone: 'Sprint 05' });
    await settle();
    const form = dialog() as HTMLElement;
    expect(text(form.querySelector('[data-testid="request-error"]'))).toContain('сейчас она Sprint 05');
    expect(text(form.querySelector('[data-testid="request-now"]'))).toBe('Сейчас: Sprint 05');
    expect(form.querySelector<HTMLInputElement>('[data-testid="request-queue-up"]')?.checked).toBe(true);
    press('.tc-sheet__foot button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('on issue-closed says so and offers only Close', async () => {
    const { pending } = await openForm();
    press('[data-testid="request-queue-down"]');
    await settle();
    press('[data-testid="request-ok"]');
    await settle();
    http
      .expectOne(issueRequestUrl('tc', 7))
      .flush(
        { type: 'https://team-console/problems/issue-closed', title: 'Closed', status: 409 },
        { status: 409, statusText: 'Conflict', headers: { 'Content-Type': 'application/problem+json' } },
      );
    await settle();
    expect(text(dialog()?.querySelector('[data-testid="request-error"]'))).toContain('Задачу уже закрыли');
    expect(dialog()?.querySelector('[data-testid="request-ok"]')).toBeNull();
    press('.tc-sheet__foot button[type=button]');
    await expect(pending).resolves.toBeNull();
  });

  it('says the request is off without the owner connection, before any dialog', async () => {
    status.status.set({ ...STATUS, ownerConnected: false });
    await expect(requests.ask(TARGET)).resolves.toMatchObject({ tone: 'warning' });
    expect(dialog()).toBeNull();
  });
});
