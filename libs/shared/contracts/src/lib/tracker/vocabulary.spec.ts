import {
  ITEM_STATUSES,
  isWorkableStatus,
  isAskCategory,
  isAskCommand,
  isDecisionCommand,
  isDecisionVia,
  isFlagName,
  isItemStatus,
  isRequestKind,
  isRequestResult,
  itemKeyOf,
  itemNumberOfKey,
} from './vocabulary';

describe('tracker vocabulary', () => {
  it('narrows only the listed values', () => {
    expect(isItemStatus('qa')).toBe(true);
    expect(isItemStatus('status:qa')).toBe(false);
    expect(isItemStatus(undefined)).toBe(false);
  });

  it('counts every status but proposed and done as workable', () => {
    expect(ITEM_STATUSES.filter(isWorkableStatus)).toEqual(['approved', 'in-progress', 'qa', 'blocked']);
  });

  it.each(['security', 'design:approved', 'agent:dev-light', 'release-blocker', 'needs:owner'])(
    'accepts the flag %s',
    (name) => {
      expect(isFlagName(name)).toBe(true);
    },
  );

  it.each(['status:qa', 'kind:bug', 'tier:heavy', 'sev:high', 'Security', '-x', '', 'a'.repeat(51), 'a b'])(
    'refuses %j as a flag',
    (name) => {
      expect(isFlagName(name)).toBe(false);
    },
  );

  it('builds and reads an item key', () => {
    expect(itemKeyOf('TC', 310)).toBe('TC-310');
    expect(itemNumberOfKey('TC-310', 'TC')).toBe(310);
    expect(itemNumberOfKey('310', 'TC')).toBe(310);
  });

  it('tells another project apart from a malformed key', () => {
    expect(itemNumberOfKey('ST-4', 'TC')).toBe('other-project');
    expect(itemNumberOfKey('tc-4', 'TC')).toBeNull();
    expect(itemNumberOfKey('TC-0', 'TC')).toBeNull();
    expect(itemNumberOfKey('04', 'TC')).toBeNull();
    expect(itemNumberOfKey('1e3', 'TC')).toBeNull();
    expect(itemNumberOfKey('TC-1234567890', 'TC')).toBeNull();
  });

  it('narrows the 1a′ vocabulary (#434)', () => {
    expect(isAskCategory('legal')).toBe(true);
    expect(isAskCategory('owner:legal')).toBe(false);
    expect(isDecisionCommand('resume')).toBe(true);
    expect(isAskCommand('resume')).toBe(false);
    expect(isAskCommand('no-go')).toBe(true);
    expect(isDecisionVia('import')).toBe(true);
    expect(isDecisionVia('job')).toBe(false);
    expect(isRequestKind('priority')).toBe(true);
    expect(isRequestResult('pending')).toBe(false);
  });
});
