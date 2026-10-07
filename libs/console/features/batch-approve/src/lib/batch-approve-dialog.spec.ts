import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AnsweredItems, NeedsYouCounts } from '@console/entities/project';
import type { QuestionItem } from '@console/entities/question';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { DIALOG_DATA, DialogRef } from '@console/shared/ui';
import { PROBLEM_TYPE_PREFIX, type BatchAnswerRequest } from '@shared/contracts';
import { BatchApproveDialog, BatchSession, type BatchApproveData } from './batch-approve-dialog';
import { BatchApproveClient, type BatchSubmitResult } from './batch-approve.client';

function item(number: number, slug = 'tc', overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug, name: slug.toUpperCase() },
    section: 'question',
    number,
    title: `Question ${number}`,
    url: null,
    ask: '/approve — начинаем (рекомендую) · /reject что поменять',
    body: null,
    authorTrusted: true,
    allowedCommands: ['approve', 'reject'],
    category: 'scope',
    recommendation: 'approve',
    ...overrides,
  };
}

const written = (number: number) => ({
  number,
  ok: true as const,
  commentId: number * 10,
  url: `https://github.com/o/r/issues/${number}#c`,
  replayed: false,
});
const failedWith = (number: number, slug: string) => ({
  number,
  ok: false as const,
  problem: { type: `${PROBLEM_TYPE_PREFIX}${slug}`, title: 'x', status: 502 },
});

async function render(
  candidates: QuestionItem[],
  answer: (slug: string, request: BatchAnswerRequest) => BatchSubmitResult,
  data: Partial<BatchApproveData> = {},
) {
  const calls: { slug: string; request: BatchAnswerRequest }[] = [];
  const close = vi.fn();
  const recorded: unknown[] = [];
  const session = new BatchSession();
  TestBed.configureTestingModule({
    providers: [
      provideConsoleI18n(),
      { provide: DialogRef, useValue: { close, disableClose: false } },
      { provide: DIALOG_DATA, useValue: { candidates, leftOut: [], session, ...data } },
      {
        provide: BatchApproveClient,
        useValue: {
          submit: async (slug: string, request: BatchAnswerRequest) => {
            calls.push({ slug, request });
            return answer(slug, request);
          },
        },
      },
      { provide: AnsweredItems, useValue: { record: (value: unknown) => recorded.push(value) } },
      { provide: NeedsYouCounts, useValue: { refresh: async () => undefined } },
    ],
  });
  await firstValueFrom(TestBed.inject(TranslocoService).load('ru'));
  const fixture = TestBed.createComponent(BatchApproveDialog);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const ok = (): HTMLButtonElement => root.querySelector('[data-testid="batch-ok"]') as HTMLButtonElement;
  const press = async (): Promise<void> => {
    ok().click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };
  return { fixture, root, ok, press, calls, close, recorded, session };
}

describe('BatchApproveDialog', () => {
  it('ticks every candidate and sends one request per project with the design’s words', async () => {
    const { root, ok, press, calls, close, recorded, session } = await render(
      [item(1), item(2, 'storify'), item(3)],
      (_slug, request) => ({ ok: true, results: request.numbers.map(written) }),
    );
    expect(root.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(3);
    expect(ok().textContent).toContain('Одобрить 3');
    expect(root.textContent).toContain('«Одобряю совет команды (пакетно, 3)»');

    await press();

    expect(calls).toEqual([
      { slug: 'tc', request: { numbers: [1, 3], ownerSaid: 'Одобряю совет команды (пакетно, 3)' } },
      { slug: 'storify', request: { numbers: [2], ownerSaid: 'Одобряю совет команды (пакетно, 3)' } },
    ]);
    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({ slug: 'tc', number: 1, command: 'approve', batch: true });
    expect(session.approved().map((approved) => approved.number)).toEqual([1, 3, 2]);
    expect(close).toHaveBeenCalled();
  });

  it('sends only the ticked items', async () => {
    const { fixture, root, press, calls } = await render([item(1), item(2)], (_slug, request) => ({
      ok: true,
      results: request.numbers.map(written),
    }));
    (root.querySelector('[data-number="2"] input') as HTMLInputElement).click();
    await fixture.whenStable();
    await press();
    expect(calls.map((call) => call.request.numbers)).toEqual([[1]]);
    expect(calls[0]?.request.ownerSaid).toBe('Одобряю совет команды (пакетно, 1)');
  });

  it('keeps only the failed items with Try again, and retries them with the same words', async () => {
    let attempt = 0;
    const { root, ok, press, calls, close } = await render([item(1), item(2), item(3)], (_slug, request) => {
      attempt += 1;
      return attempt === 1
        ? { ok: true, results: [written(1), failedWith(2, 'github-unavailable'), written(3)] }
        : { ok: true, results: request.numbers.map(written) };
    });

    await press();

    expect(close).not.toHaveBeenCalled();
    expect([...root.querySelectorAll('tc-check-row')].map((row) => row.getAttribute('data-number'))).toEqual([
      '2',
    ]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Одобрено 2 из 3');
    expect(ok().textContent).toContain('Повторить');

    await press();

    expect(calls[1]?.request).toEqual({ numbers: [2], ownerSaid: 'Одобряю совет команды (пакетно, 3)' });
    expect(close).toHaveBeenCalled();
  });

  it('says why a whole request failed and keeps everything for Try again', async () => {
    const { root, press, close } = await render([item(1)], () => ({ ok: false, failure: 'connect' }));
    await press();
    expect(close).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('GitHub не подключён');
  });

  it('drops an item that changed meanwhile and asks for a fresh list', async () => {
    const { root, press, session } = await render([item(1), item(2)], () => ({
      ok: true,
      results: [written(1), failedWith(2, 'batch-not-safe')],
    }));
    await press();
    expect(session.changed().map((changed) => changed.number)).toEqual([2]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('#2');
    expect(root.querySelectorAll('tc-check-row')).toHaveLength(0);
  });

  it('lists what was left out with the reason', async () => {
    const { root } = await render([item(1)], () => ({ ok: true, results: [] }), {
      leftOut: [{ item: item(9, 'tc', { category: 'money' }), reason: 'money' }],
    });
    const out = root.querySelector('[data-testid="batch-left-out"]');
    expect(out?.textContent).toContain('Не вошли: 1');
    expect(out?.textContent).toContain('деньги');
  });

  it('does nothing with nothing ticked', async () => {
    const { fixture, root, ok, press, calls } = await render([item(1)], () => ({ ok: true, results: [] }));
    (root.querySelector('input') as HTMLInputElement).click();
    await fixture.whenStable();
    expect(ok().textContent).toContain('Ничего не отмечено');
    expect(ok().getAttribute('aria-disabled')).toBe('true');
    await press();
    expect(calls).toEqual([]);
  });
});
