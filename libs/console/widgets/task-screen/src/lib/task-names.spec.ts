import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n, TranslocoService } from '@console/shared/i18n';
import type { HistoryEntry } from '@console/entities/item';
import { TaskNames } from './task-names';

const ACTOR = { kind: 'owner' as const, name: 'owner' };

function entryOf(line: HistoryEntry['line']): HistoryEntry {
  return { id: 'e1', at: '2026-11-01T00:00:00.000Z', actor: ACTOR, isOwner: true, line };
}

describe('TaskNames.line, decided (#470 item 4)', () => {
  function names(): TaskNames {
    TestBed.configureTestingModule({ providers: [provideConsoleI18n()] });
    return new TaskNames(TestBed.inject(TranslocoService), () => []);
  }

  it('reads a plain approve (no recorded text) as the fixed word', () => {
    expect(names().line(entryOf({ kind: 'decided', command: 'approve', text: '' }))).toBe('Утверждено');
  });

  it("reads a batch approval's recorded phrase readably, quoted after the fixed word", () => {
    const text = 'Одобряю совет команды (пакетно, 3)';
    expect(names().line(entryOf({ kind: 'decided', command: 'approve', text }))).toBe(
      `Утверждено: «${text}»`,
    );
  });

  it('still reads reject with its reason, unaffected by the approve change', () => {
    expect(names().line(entryOf({ kind: 'decided', command: 'reject', text: 'Not this sprint' }))).toBe(
      'Отклонено: «Not this sprint»',
    );
  });
});
