import { ACTIONS_SETUP_BRANCH_PREFIX, actionsSetupBranchOf } from './setup-branch';

describe('actionsSetupBranchOf', () => {
  it('names the branch after the first 12 hex characters of the rendering', () => {
    const sha256 = 'ab12'.repeat(16);
    expect(actionsSetupBranchOf(sha256)).toBe(`${ACTIONS_SETUP_BRANCH_PREFIX}ab12ab12ab12`);
  });

  it.each(['', 'AB12'.repeat(16), 'ab12'.repeat(15), `${'ab12'.repeat(16)}\n`, 'zz'.repeat(32)])(
    'refuses %j: only a lower-case hex sha256 names a branch',
    (value) => {
      expect(() => actionsSetupBranchOf(value)).toThrow(RangeError);
    },
  );
});
