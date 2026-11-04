import { TestBed } from '@angular/core/testing';
import type { QuestionItem } from '@console/entities/question';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import { Sheet } from '@console/shared/ui';
import { firstValueFrom, Subject } from 'rxjs';
import { BatchApproveDialog, type BatchApproveData } from './batch-approve-dialog';
import { BatchApproveOpener } from './batch-approve-opener';

function item(number: number, slug = 'tc', overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: { slug, name: slug.toUpperCase() },
    section: 'question',
    number,
    title: `Question ${number}`,
    url: null,
    ask: '/approve (recommended) · /reject why',
    body: null,
    authorTrusted: true,
    allowedCommands: ['approve', 'reject'],
    category: 'scope',
    recommendation: 'approve',
    context: null,
    ...overrides,
  };
}

describe('BatchApproveOpener', () => {
  let open: ReturnType<typeof vi.fn>;
  let closed: Subject<void>;

  async function setup(): Promise<BatchApproveOpener> {
    closed = new Subject<void>();
    open = vi.fn(() => ({ closed }));
    TestBed.configureTestingModule({
      providers: [provideConsoleI18n(), { provide: Sheet, useValue: { open } }],
    });
    await firstValueFrom(TestBed.inject(TranslocoService).load('ru'));
    return TestBed.inject(BatchApproveOpener);
  }

  it('opens the dialog over the safe items with what was left out, and reports what it approved', async () => {
    const opener = await setup();
    const pending = opener.open([item(1), item(2, 'tc', { category: 'money' })]);
    expect(opener.isOpen()).toBe(true);
    const [content, options] = open.mock.calls[0] as [unknown, { title: string; data: BatchApproveData }];
    expect(content).toBe(BatchApproveDialog);
    expect(options.title).toBe('Одобрить советы команды?');
    expect(options.data.candidates.map((candidate) => candidate.number)).toEqual([1]);
    expect(options.data.leftOut.map((left) => left.reason)).toEqual(['money']);
    options.data.session.approved.set([item(1)]);
    closed.next();
    await expect(pending).resolves.toEqual({ approved: [item(1)], hasChanged: false });
    expect(opener.isOpen()).toBe(false);
  });

  it('titles a batch across projects for every project', async () => {
    const opener = await setup();
    void opener.open([item(1, 'tc'), item(2, 'fn')]);
    expect((open.mock.calls[0] as [unknown, { title: string }])[1].title).toBe(
      'Одобрить советы команды во всех проектах?',
    );
    closed.next();
  });

  it('opens nothing with nothing safe to batch, or while a dialog is open', async () => {
    const opener = await setup();
    await expect(opener.open([item(1, 'tc', { recommendation: 'reject' })])).resolves.toBeNull();
    expect(open).not.toHaveBeenCalled();
    const first = opener.open([item(1)]);
    await expect(opener.open([item(1)])).resolves.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    closed.next();
    await first;
  });
});
