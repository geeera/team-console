import { JOB_KINDS, roleOfJobKind } from '@shared/contracts';
import { dedupeKeyOf } from './jobs';

// ADR 0010 decision 3 (#1039): one live orchestrator job per project, whichever way it was started.

describe('dedupeKeyOf', () => {
  it.each(['slot-pm', 'slot-dev', 'slot-qa', 'burn', 'kickoff', 'orchestrate'] as const)(
    'gives %s the shared orchestrator key',
    (kind) => {
      expect(dedupeKeyOf('acme', kind)).toBe('acme:orchestrator');
    },
  );

  it('covers every kind that runs as the orchestrator, so a new one cannot slip past the guard', () => {
    for (const kind of JOB_KINDS) {
      if (roleOfJobKind(kind, null) === 'orchestrator') {
        expect(dedupeKeyOf('acme', kind), kind).toBe('acme:orchestrator');
      }
    }
  });

  it('keeps import on its own key', () => {
    expect(dedupeKeyOf('acme', 'import')).toBe('acme:import');
  });

  it.each(['review', 'task', 'chat', 'digest', 'audit'] as const)('gives Run now of %s no key', (kind) => {
    expect(dedupeKeyOf('acme', kind)).toBeNull();
  });
});
