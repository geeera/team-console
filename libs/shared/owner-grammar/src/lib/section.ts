import type { Section } from '@shared/contracts';

/** The issue's kind as `backlog answer` reads it: the first `kind:*` label, without the prefix. */
export function kindOf(labels: readonly string[]): string | null {
  const label = labels.find((name) => name.startsWith('kind:'));
  return label === undefined ? null : label.slice('kind:'.length);
}

/**
 * The owner's inbox section of an issue (`inbox.classify`). The order of the checks is the plugin's: a demo issue
 * that also needs the owner is a release decision, a design waiting for approval is a design even when it is a
 * question, and a question stays a question when it also carries `needs:owner`.
 */
export function sectionOf(labels: readonly string[], kind: string | null): Section | null {
  const names = new Set(labels);
  if (names.has('team:demo')) {
    return 'release';
  }
  if (names.has('design:awaiting-approval')) {
    return 'design';
  }
  if (names.has('needs:owner') && kind !== 'question') {
    return 'owner';
  }
  if (kind === 'question') {
    return 'question';
  }
  if (names.has('needs:local')) {
    return 'local';
  }
  return null;
}
