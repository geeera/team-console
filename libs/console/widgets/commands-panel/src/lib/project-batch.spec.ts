import { TestBed } from '@angular/core/testing';
import { ANSWERED_ITEMS_STORAGE, AnsweredItems } from '@console/entities/project';
import { QuestionsApi, type QuestionItem } from '@console/entities/question';
import { ProjectBatch } from './project-batch';

const REF = { slug: 'tc', name: 'Team Console' };

function item(number: number, overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    project: REF,
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

describe('ProjectBatch', () => {
  let read: ReturnType<typeof vi.fn>;

  function setup(): ProjectBatch {
    read = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        ProjectBatch,
        { provide: QuestionsApi, useValue: { projectQuestions: read } },
        { provide: ANSWERED_ITEMS_STORAGE, useValue: { read: () => null, write: () => undefined } },
      ],
    });
    return TestBed.inject(ProjectBatch);
  }

  it('counts what the batch would take and what it leaves out, once read', async () => {
    const batch = setup();
    expect(batch.view()).toEqual({ kind: 'loading' });
    read.mockResolvedValue([
      item(1),
      item(2, { category: 'release' }),
      item(3, { section: 'owner', allowedCommands: ['done'] }),
    ]);
    await batch.load(REF);
    expect(read).toHaveBeenCalledWith(REF);
    expect(batch.view()).toEqual({ kind: 'ready', count: 1, leftOut: 1 });
  });

  it('forgets answers GitHub no longer lists, and skips the ones still listed', async () => {
    const batch = setup();
    const answered = TestBed.inject(AnsweredItems);
    const answer = (number: number) => ({
      slug: 'tc',
      number,
      command: 'approve' as const,
      url: `https://github.com/o/r/issues/${number}#c`,
      answeredAt: new Date().toISOString(),
    });
    answered.record(answer(1));
    answered.record(answer(9));
    read.mockResolvedValue([item(1), item(2)]);
    await batch.load(REF);
    expect(batch.waiting().map((waiting) => waiting.number)).toEqual([2]);
    expect(answered.has('tc', 9)).toBe(false);
    expect(answered.has('tc', 1)).toBe(true);
  });

  it('says it could not read; a failed re-read keeps what it had', async () => {
    const batch = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    read.mockRejectedValueOnce(new Error('down'));
    await batch.load(REF);
    expect(batch.view()).toEqual({ kind: 'error' });
    read.mockResolvedValueOnce([item(1)]);
    await batch.load(REF);
    read.mockRejectedValueOnce(new Error('down'));
    await batch.load(REF);
    expect(batch.view()).toEqual({ kind: 'ready', count: 1, leftOut: 0 });
    warn.mockRestore();
  });

  it('drops a read that a newer one overtook', async () => {
    const batch = setup();
    let first: (items: QuestionItem[]) => void = () => undefined;
    read.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)));
    const slow = batch.load(REF);
    batch.reset();
    read.mockResolvedValueOnce([]);
    await batch.load(REF);
    first([item(1)]);
    await slow;
    expect(batch.view()).toEqual({ kind: 'ready', count: 0, leftOut: 0 });
  });
});
