import type { QuickTaskSprintOptions } from '@console/entities/sprint';
import type { TrackerSprintDto } from '@shared/contracts';
import { chosenTargetOf, hasCommandLine, sprintOf, withRefusedSprints } from './quick-task.model';

const sprint = (number: number): TrackerSprintDto =>
  ({ number, title: `Sprint 0${String(number)}`, dueOn: '2031-01-01', state: 'open' }) as TrackerSprintDto;

const OPTIONS: QuickTaskSprintOptions = {
  current: { target: 'current', sprint: sprint(4), disabledReason: null },
  next: { target: 'next', sprint: sprint(5), disabledReason: null },
  backlog: { target: 'backlog', sprint: null, disabledReason: null },
  defaultTarget: 'next',
};

describe('quick task model (#107)', () => {
  it('takes the wanted target, or the default when it cannot be sent', () => {
    expect(chosenTargetOf(OPTIONS, null)).toBe('next');
    expect(chosenTargetOf(OPTIONS, 'current')).toBe('current');
    const frozen = withRefusedSprints(OPTIONS, new Set([4]));
    expect(frozen.current.disabledReason).toBe('frozen');
    expect(chosenTargetOf(frozen, 'current')).toBe('next');
  });

  it('falls back to the backlog once the next sprint was refused as frozen', () => {
    const refused = withRefusedSprints(OPTIONS, new Set([5]));
    expect(refused.defaultTarget).toBe('backlog');
    expect(chosenTargetOf(refused, 'next')).toBe('backlog');
    expect(sprintOf(refused, 'backlog')).toBeNull();
    expect(sprintOf(OPTIONS, 'next')?.number).toBe(5);
  });

  it('spots a line that reads like an owner command, anywhere in the text', () => {
    expect(hasCommandLine('fine\n  /approve please')).toBe(true);
    expect(hasCommandLine('a/b path and 1 / 2')).toBe(false);
  });
});
