import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AnsweredItems, NeedsYouCounts } from '@console/entities/project';
import type { QuestionItem } from '@console/entities/question';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { AnswerQuestion } from './answer-question';
import { decisionUrl } from './answer.client';

const ITEM: QuestionItem = {
  project: { slug: 'team-console', name: 'team-console' },
  section: 'question',
  number: 345,
  key: 'TC-345',
  askId: 17,
  title: 'A soft paper sound on the stamp',
  url: null,
  ask: 'Take it into Sprint 05?',
  body: null,
  authorTrusted: true,
  allowedCommands: ['approve', 'reject'],
  category: 'scope',
  recommendation: 'approve',
  context: null,
};

const URL = decisionUrl('team-console', 345);
const DECISION = {
  id: 9,
  command: 'approve',
  text: '',
  askId: 17,
  reversesCommentId: null,
  via: 'web',
  decidedAt: 'x',
  sourceUrl: null,
};

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideConsoleI18n(),
      { provide: Sheet, useValue: { confirm: vi.fn(async () => true), open: vi.fn() } },
      { provide: AnsweredItems, useValue: { record: vi.fn() } },
      { provide: NeedsYouCounts, useValue: { refresh: vi.fn(async () => undefined) } },
    ],
  });
  const fixture = TestBed.createComponent(AnswerQuestion);
  fixture.componentRef.setInput('item', ITEM);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

describe('AnswerQuestion on a console-tracker item (#435)', () => {
  it('records an owner decision naming the open ask, never a GitHub answer', async () => {
    const { fixture, http } = setup();
    const answered = vi.fn();
    fixture.componentInstance.answered.subscribe(answered);
    const done = fixture.componentInstance.answer('approve');
    await Promise.resolve();
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({
      command: 'approve',
      text: '',
      askId: 17,
      reversesCommentId: null,
      via: 'web',
    });
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    request.flush(DECISION, { status: 201, statusText: 'Created' });
    await done;
    expect(answered).toHaveBeenCalledWith(
      expect.objectContaining({ response: expect.objectContaining({ command: 'approve', url: '' }) }),
    );
    http.expectNone((r) => r.url.includes('/issues/'));
  });

  it('retries a dropped decision with the same idempotency key, and says when the ask moved on', async () => {
    const { fixture, http } = setup();
    const done = fixture.componentInstance.answer('approve');
    await Promise.resolve();
    const first = http.expectOne(URL);
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'), { status: 0 });
    await done;
    const retried = fixture.componentInstance.retry();
    const second = http.expectOne(URL);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush(
      { type: 'https://team-console/problems/ask-not-open', title: 'x', status: 409 },
      { status: 409, statusText: 'Conflict' },
    );
    await retried;
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="answer-error"]')
        ?.getAttribute('data-kind'),
    ).toBe('not-waiting');
  });
});
