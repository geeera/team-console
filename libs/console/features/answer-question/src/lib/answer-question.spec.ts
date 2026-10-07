import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ANSWERED_ITEMS_STORAGE, AnsweredItems, NEEDS_YOU_URL } from '@console/entities/project';
import { QuestionItem } from '@console/entities/question';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { ANSWER_REPLAY_WINDOW_MS, PROBLEM_TYPE_PREFIX, type AnswerResponse } from '@shared/contracts';
import { of } from 'rxjs';
import { AnswerGiven, AnswerQuestion } from './answer-question';
import { answerLookupUrl, answerUrl } from './answer.client';

function item(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug: 'team-console', name: 'Team Console' },
    section: 'question',
    number: 72,
    title: 'План к демо 16 октября',
    url: 'https://github.com/geeera/team-console/issues/72',
    ask: '/approve — начинаем',
    body: null,
    authorTrusted: true,
    allowedCommands: ['approve', 'reject'],
    category: 'scope',
    recommendation: null,
    context: null,
    ...overrides,
  };
}

const URL = answerUrl('team-console', 72);
const LOOKUP_URL = answerLookupUrl('team-console', 72);

function written(command: AnswerResponse['command'] = 'approve'): AnswerResponse {
  return {
    commentId: 7,
    url: 'https://github.com/geeera/team-console/issues/72#issuecomment-7',
    section: 'question',
    command,
    replayed: false,
  };
}

function problem(slug: string, status: number): object {
  return { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'refused', status };
}

@Component({
  imports: [AnswerQuestion],
  template: `<tc-answer-question
    [item]="item()"
    (answered)="given.push($event)"
    (refreshRequested)="refreshes = refreshes + 1"
  />`,
})
class Host {
  readonly item = signal(item());
  readonly given: AnswerGiven[] = [];
  refreshes = 0;
}

describe('AnswerQuestion', () => {
  let sheet: { confirm: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
  let http: HttpTestingController;

  async function render(initial = item()) {
    sheet = { confirm: vi.fn(async () => true), open: vi.fn(() => ({ closed: of('Нет бюджета') })) };
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideConsoleI18n(),
        { provide: Sheet, useValue: sheet },
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.item.set(initial);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const button = (command: string) =>
      root.querySelector(`[data-command="${command}"]`) as HTMLButtonElement;
    return { fixture, root, button, host: fixture.componentInstance };
  }

  async function tick(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async function answerWith(
    request: () => TestRequest,
    response: AnswerResponse,
    status = 201,
  ): Promise<void> {
    request().flush(response, { status, statusText: 'OK' });
    await tick();
    http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));
  }

  afterEach(() => http.verify());

  it('offers exactly the allowed commands, in their order, labelled in the owner language', async () => {
    const { root } = await render(item({ section: 'release', allowedCommands: ['go', 'no-go', 'override'] }));

    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(labels).toEqual(['Проводим', 'Переносим', 'В обход проверок']);
  });

  it('approve is one tap: the request carries the command and the owner words, nothing else', async () => {
    const { button, host, fixture } = await render();

    button('approve').click();
    await tick();
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({ command: 'approve', ownerSaid: 'Утвердить' });
    expect(sheet.confirm).not.toHaveBeenCalled();
    await answerWith(() => request, written());
    await fixture.whenStable();

    expect(host.given).toHaveLength(1);
    expect(TestBed.inject(AnsweredItems).has('team-console', 72)).toBe(true);
  });

  it('a double tap sends one request', async () => {
    const { button } = await render();

    button('approve').click();
    button('approve').click();
    button('reject').click();
    await tick();

    expect(
      http.match(URL).map((request) => request.flush(written(), { status: 201, statusText: 'Created' })),
    ).toHaveLength(1);
    await tick();
    http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));
  });

  it('marks the tapped button busy and announces it while the answer is written', async () => {
    const { button, root, fixture } = await render();

    button('approve').click();
    await tick();
    await fixture.whenStable();
    expect(button('approve').getAttribute('aria-busy')).toBe('true');
    expect(button('reject').getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Записываем ответ на #72');
    await answerWith(() => http.expectOne(URL), written());
  });

  it('an untrusted item never answers on one tap: the warning comes first, and Cancel sends nothing', async () => {
    const { button } = await render(item({ authorTrusted: false }));
    sheet.confirm.mockResolvedValueOnce(false);

    button('approve').click();
    await tick();
    http.expectNone(URL);
    expect(sheet.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Ответить на пункт не от команды?', tone: 'danger' }),
    );

    button('approve').click();
    await tick();
    await answerWith(() => http.expectOne(URL), written());
    expect(sheet.confirm).toHaveBeenCalledTimes(2);
  });

  it('reject asks for the reason and sends it in text; backing out sends nothing', async () => {
    const { button } = await render();

    button('reject').click();
    await tick();
    const request = http.expectOne(URL);
    expect(sheet.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: { command: 'reject' } }),
    );
    expect(request.request.body).toEqual({ command: 'reject', text: 'Нет бюджета', ownerSaid: 'Отклонить' });
    await answerWith(() => request, written('reject'));

    sheet.open.mockReturnValueOnce({ closed: of(undefined) });
    button('reject').click();
    await tick();
    http.expectNone(URL);
  });

  it('go asks for confirmation; no-go and override ask for a reason', async () => {
    const { button } = await render(
      item({ section: 'release', allowedCommands: ['go', 'no-go', 'override'] }),
    );

    sheet.confirm.mockResolvedValueOnce(false);
    button('go').click();
    await tick();
    http.expectNone(URL);
    expect(sheet.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Проводим релиз?' }));

    button('override').click();
    await tick();
    expect(sheet.open).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Выпустить в обход проверок?', data: { command: 'override' } }),
    );
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({
      command: 'override',
      text: 'Нет бюджета',
      ownerSaid: 'В обход проверок',
    });
    await answerWith(() => request, written('override'));
  });

  it('403 github-owner-not-connected offers Connect GitHub (Settings) instead of an error', async () => {
    const { button, root, fixture, host } = await render();

    button('approve').click();
    await tick();
    http
      .expectOne(URL)
      .flush(problem('github-owner-not-connected', 403), { status: 403, statusText: 'Forbidden' });
    await tick();
    await fixture.whenStable();

    const connect = root.querySelector('[data-testid="answer-connect"]') as HTMLElement;
    expect(connect.textContent).toContain('Подключите GitHub');
    expect(connect.querySelector('a')?.getAttribute('href')).toBe('/settings');
    expect(root.querySelector('[data-testid="answer-error"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(host.given).toHaveLength(0);
  });

  it.each([
    ['github-owner-mismatch', 409, 'Подключён не тот аккаунт GitHub'],
    ['github-app-not-installed', 409, 'Приложение консоли не установлено в репозитории'],
    ['issue-closed', 409, 'Этот пункт уже закрыт'],
    ['answer-not-allowed', 422, 'Такой ответ сюда больше не подходит'],
  ])('%s keeps the card and shows its own message in the shared error block', async (slug, status, title) => {
    const { button, root, fixture, host } = await render();

    button('approve').click();
    await tick();
    http.expectOne(URL).flush(problem(slug, status), { status, statusText: 'Refused' });
    await tick();
    await fixture.whenStable();

    const block = root.querySelector('[data-testid="answer-error"]') as HTMLElement;
    expect(block.getAttribute('role')).toBe('alert');
    expect(block.textContent).toContain(title);
    expect(button('approve')).not.toBeNull();
    expect(host.given).toHaveLength(0);
  });

  it('Retry repeats the identical request after a network failure, and a replay counts as answered', async () => {
    const { button, root, fixture, host } = await render();

    button('approve').click();
    await tick();
    const first = http.expectOne(URL);
    const body = first.request.body;
    first.error(new ProgressEvent('error'), { status: 0, statusText: '' });
    await tick();
    await fixture.whenStable();
    expect(root.querySelector('[data-testid="answer-error"]')?.getAttribute('data-kind')).toBe('offline');

    (root.querySelector('[data-testid="answer-error"] button') as HTMLButtonElement).click();
    await tick();
    const second = http.expectOne(URL);
    expect(second.request.body).toEqual(body);
    second.flush(
      { ...written(), replayed: true },
      { status: 200, statusText: 'OK', headers: { 'Idempotent-Replayed': 'true' } },
    );
    await tick();
    http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));

    expect(host.given[0]?.response.replayed).toBe(true);
  });

  describe('Retry past the replay window re-reads the item first (#120)', () => {
    let clock: number;

    beforeEach(() => {
      clock = Date.parse('2026-10-06T12:00:00Z');
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Taps approve and loses the response (status 0); the card shows offline with Retry. */
    async function lostAnswer() {
      const rendered = await render();
      rendered.button('approve').click();
      await tick();
      const first = http.expectOne(URL);
      first.error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await tick();
      await rendered.fixture.whenStable();
      const retry = (): void =>
        (rendered.root.querySelector('[data-testid="answer-error"] button') as HTMLButtonElement).click();
      return { ...rendered, body: first.request.body as object, retry };
    }

    it('within the window, Retry posts the same request again and reads nothing (the endpoint replays)', async () => {
      const { retry, body, host } = await lostAnswer();

      clock += ANSWER_REPLAY_WINDOW_MS;
      retry();
      await tick();

      http.expectNone(LOOKUP_URL);
      const again = http.expectOne(URL);
      expect(again.request.body).toEqual(body);
      await answerWith(() => again, { ...written(), replayed: true }, 200);
      expect(host.given).toHaveLength(1);
    });

    it('past the window, an answer already on GitHub is shown as answered and nothing is posted', async () => {
      const { retry, body, host, fixture, root } = await lostAnswer();

      clock += ANSWER_REPLAY_WINDOW_MS + 1_000;
      retry();
      await tick();

      http.expectNone(URL);
      const read = http.expectOne(LOOKUP_URL);
      expect(read.request.method).toBe('POST');
      expect(read.request.body).toEqual({ ...body, sentAgoMs: ANSWER_REPLAY_WINDOW_MS + 1_000 });
      read.flush({ answer: { ...written(), replayed: true } });
      await tick();
      http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));
      await fixture.whenStable();

      http.expectNone(URL);
      expect(host.given).toEqual([{ item: item(), response: { ...written(), replayed: true } }]);
      expect(TestBed.inject(AnsweredItems).get('team-console', 72)?.url).toBe(written().url);
      expect(root.querySelector('[data-testid="answer-error"]')).toBeNull();
    });

    it('past the window, an item still waiting gets the answer posted once', async () => {
      const { retry, body, host } = await lostAnswer();

      clock += 5 * 60_000;
      retry();
      await tick();
      http.expectOne(LOOKUP_URL).flush({ answer: null });
      await tick();

      const post = http.expectOne(URL);
      expect(post.request.body).toEqual(body);
      await answerWith(() => post, written());
      http.expectNone(URL);
      expect(host.given).toHaveLength(1);
      expect(host.given[0]?.response.replayed).toBe(false);
    });

    it('the window counts from the last attempt; the re-read looks back to the first', async () => {
      const { retry } = await lostAnswer();

      clock += 30_000;
      retry();
      await tick();
      http.expectOne(URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await tick();

      clock += 50_000;
      retry();
      await tick();
      http.expectOne(URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await tick();

      clock += ANSWER_REPLAY_WINDOW_MS + 1;
      retry();
      await tick();
      const read = http.expectOne(LOOKUP_URL);
      expect((read.request.body as { sentAgoMs: number }).sentAgoMs).toBe(
        30_000 + 50_000 + ANSWER_REPLAY_WINDOW_MS + 1,
      );
      read.flush({ answer: { ...written(), replayed: true } });
      await tick();
      http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));
    });

    it('tapping the same answer again instead of Retry is the same repeat: re-read first', async () => {
      const { button, host } = await lostAnswer();

      clock += 2 * 60_000;
      button('approve').click();
      await tick();
      http.expectNone(URL);
      http.expectOne(LOOKUP_URL).flush({ answer: { ...written(), replayed: true } });
      await tick();
      http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));

      expect(host.given).toHaveLength(1);
    });

    it('an item that no longer takes the answer offers a fresh list, and nothing is posted', async () => {
      const { retry, root, fixture, host } = await lostAnswer();

      clock += 2 * 60_000;
      retry();
      await tick();
      http.expectOne(LOOKUP_URL).flush(problem('issue-closed', 409), { status: 409, statusText: 'Conflict' });
      await tick();
      await fixture.whenStable();

      http.expectNone(URL);
      const error = root.querySelector('[data-testid="answer-error"]');
      expect(error?.getAttribute('data-kind')).toBe('issue-closed');
      (error?.querySelector('button') as HTMLButtonElement).click();
      expect(host.refreshes).toBe(1);
      expect(host.given).toHaveLength(0);
    });

    it('a re-read that fails offline posts nothing and keeps Retry, which re-reads again', async () => {
      const { retry, root, fixture } = await lostAnswer();

      clock += 2 * 60_000;
      retry();
      await tick();
      http.expectOne(LOOKUP_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await tick();
      await fixture.whenStable();

      http.expectNone(URL);
      expect(root.querySelector('[data-testid="answer-error"]')?.getAttribute('data-kind')).toBe('offline');
      retry();
      await tick();
      http.expectOne(LOOKUP_URL).flush({ answer: null });
      await tick();
      await answerWith(() => http.expectOne(URL), written());
    });
  });

  it('answer-in-progress waits out Retry-After, then repeats once and gets the replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { button, host } = await render();

      button('approve').click();
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne(URL).flush(problem('answer-in-progress', 409), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Retry-After': '2' },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      http.expectNone(URL);
      await vi.advanceTimersByTimeAsync(1_000);
      http.expectOne(URL).flush({ ...written(), replayed: true }, { status: 200, statusText: 'OK' });
      await vi.advanceTimersByTimeAsync(0);
      http.match(NEEDS_YOU_URL).forEach((counts) => counts.flush({ items: [] }));

      expect(host.given).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refresh recovery asks the list to read again', async () => {
    const { button, root, fixture, host } = await render();

    button('approve').click();
    await tick();
    http
      .expectOne(URL)
      .flush(problem('answer-not-waiting', 422), { status: 422, statusText: 'Unprocessable' });
    await tick();
    await fixture.whenStable();
    (root.querySelector('[data-testid="answer-error"] button') as HTMLButtonElement).click();

    expect(host.refreshes).toBe(1);
  });
});
