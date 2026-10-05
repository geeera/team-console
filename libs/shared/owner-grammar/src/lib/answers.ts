import type { AnswerCommand, Section } from '@shared/contracts';

/** What each section is answered with (`brief.ANSWERS`). Action items are reported done, never approved. */
export const ANSWERS: Readonly<Record<Section, readonly AnswerCommand[]>> = Object.freeze({
  question: Object.freeze(['approve', 'reject'] as const),
  design: Object.freeze(['approve', 'reject'] as const),
  release: Object.freeze(['go', 'no-go', 'override'] as const),
  owner: Object.freeze(['done'] as const),
  local: Object.freeze(['done'] as const),
});

/** Every command an answer can carry (`brief.ANSWERABLE`, sorted like the plugin's). */
export const ANSWERABLE: readonly AnswerCommand[] = Object.freeze([
  'approve',
  'done',
  'go',
  'no-go',
  'override',
  'reject',
]);

/** Commands that need the owner's reason in `text`. */
export const NEEDS_REASON: ReadonlySet<AnswerCommand> = new Set(['reject', 'no-go', 'override']);

export function isAnswerCommand(value: unknown): value is AnswerCommand {
  return typeof value === 'string' && (ANSWERABLE as readonly string[]).includes(value);
}

/** The commands a section accepts; none for an issue that is not waiting for the owner. */
export function allowedAnswers(section: Section | null): readonly AnswerCommand[] {
  return section === null ? [] : ANSWERS[section];
}
