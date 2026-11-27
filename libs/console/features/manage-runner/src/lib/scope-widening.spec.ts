import { runnerFixture } from '@console/entities/runner';
import { scopeWideningOf } from './scope-widening';

describe('scopeWideningOf (#825)', () => {
  const options = ['mine', 'served', 'theirs'];

  it('locks nothing for an owner who may widen the runner', () => {
    const runner = runnerFixture({ canWiden: true, allowedProjects: ['mine'] });
    expect(scopeWideningOf(runner, true, options, ['mine'])).toEqual({
      allLocked: false,
      lockedSlugs: new Set(),
    });
  });

  it('locks all projects and every row the runner neither holds nor serves for a non-enroller', () => {
    const runner = runnerFixture({
      canWiden: false,
      projectScope: 'selected',
      allowedProjects: ['mine'],
      servedProjects: [{ slug: 'served', accessSource: 'subscription', fit: true }],
    });
    expect(scopeWideningOf(runner, false, options, ['mine'])).toEqual({
      allLocked: true,
      lockedSlugs: new Set(['theirs']),
    });
  });

  it('keeps all projects open on a runner that is under all already, and the rows it serves there', () => {
    const runner = runnerFixture({
      canWiden: false,
      projectScope: 'all',
      allowedProjects: [],
      servedProjects: [{ slug: 'served', accessSource: 'subscription', fit: true }],
    });
    expect(scopeWideningOf(runner, false, options, [])).toEqual({
      allLocked: false,
      lockedSlugs: new Set(['mine', 'theirs']),
    });
  });

  it('leaves a ticked addition open so the owner can untick it', () => {
    const runner = runnerFixture({ canWiden: true, projectScope: 'selected', allowedProjects: [] });
    expect(scopeWideningOf(runner, false, options, ['theirs']).lockedSlugs).toEqual(
      new Set(['mine', 'served']),
    );
  });
});
