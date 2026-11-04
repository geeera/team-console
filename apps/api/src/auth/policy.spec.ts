import type { ItemStatus } from '@shared/contracts';
import {
  policyActorOf,
  transitionRefusal,
  type ItemPolicyState,
  type ItemTransition,
  type PolicyActor,
} from './policy';

// R5 of the #408 threat model: owner-semantic status and flags are the owner's alone; roles act within the table.

const OWNER: PolicyActor = { kind: 'owner' };
const job = (role: string, holdsItem = false): PolicyActor => ({ kind: 'job', role, holdsItem });

function state(status: ItemStatus, flags: string[] = [], closed = status === 'done'): ItemPolicyState {
  return { status, flags, closed };
}

function change(
  before: ItemPolicyState | null,
  after: ItemPolicyState,
  changesOtherFields = false,
): ItemTransition {
  return { before, after, changesOtherFields };
}

const refusal = (actor: PolicyActor, transition: ItemTransition) => transitionRefusal(actor, transition);

describe('transition table: owner-semantic changes (transition-owner-only)', () => {
  const cases: [string, ItemTransition][] = [
    ['proposed → approved', change(state('proposed'), state('approved'))],
    ['a new item created as approved', change(null, state('approved'))],
    ['adding design:approved', change(state('in-progress'), state('in-progress', ['design:approved']))],
    ['removing design:approved', change(state('in-progress', ['design:approved']), state('in-progress'))],
    ['adding an owner:* flag', change(state('blocked'), state('blocked', ['owner:scope']))],
    ['removing an owner:* flag', change(state('blocked', ['owner:release']), state('blocked'))],
    ['closing the demo item as done', change(state('qa', ['team:demo']), state('done', ['team:demo']))],
    [
      'closing the demo item as not planned',
      change(state('qa', ['team:demo']), { status: 'qa', flags: ['team:demo'], closed: true }),
    ],
  ];

  it.each(cases)('%s is refused to every role, PM and orchestrator included', (_, transition) => {
    for (const role of ['pm', 'architect', 'orchestrator', 'security', 'dev', 'qa']) {
      expect(refusal(job(role, true), transition)?.type).toBe('transition-owner-only');
    }
  });

  it.each(cases)('%s is the owner’s to make', (_, transition) => {
    expect(refusal(OWNER, transition)).toBeNull();
  });

  it('names why, for the log and the problem', () => {
    expect(refusal(job('pm'), cases[0]?.[1] ?? change(null, state('proposed')))).toEqual({
      type: 'transition-owner-only',
      reason: 'approve',
    });
  });

  it('lets a role move an approved item on without the owner', () => {
    expect(refusal(job('pm'), change(state('approved'), state('in-progress')))).toBeNull();
    expect(refusal(job('dev', true), change(state('in-progress'), state('qa')))).toBeNull();
  });
});

describe('transition table: role limits (transition-role)', () => {
  it('lets the editing roles create and edit within the table', () => {
    for (const role of ['pm', 'architect', 'orchestrator']) {
      expect(refusal(job(role), change(null, state('proposed', ['needs-design'])))).toBeNull();
      expect(refusal(job(role), change(state('proposed'), state('proposed'), true))).toBeNull();
    }
  });

  it('keeps workflow-change to the owner and the security role', () => {
    const adding = change(state('approved'), state('approved', ['workflow-change']));
    expect(refusal(job('pm'), adding)).toEqual({ type: 'transition-role', reason: 'workflow-change' });
    expect(refusal(job('orchestrator'), adding)?.reason).toBe('workflow-change');
    expect(refusal(job('security'), adding)).toBeNull();
    expect(refusal(OWNER, adding)).toBeNull();
  });

  it('lets only security or the PM remove release-blocker and security', () => {
    for (const flag of ['release-blocker', 'security']) {
      const removing = change(state('qa', [flag]), state('qa'));
      expect(refusal(job('architect'), removing)).toEqual({
        type: 'transition-role',
        reason: 'remove-guard-flag',
      });
      expect(refusal(job('dev', true), removing)?.reason).toBe('remove-guard-flag');
      expect(refusal(job('pm'), removing)).toBeNull();
      expect(refusal(job('security'), removing)).toBeNull();
    }
    expect(refusal(job('architect'), change(state('qa'), state('qa', ['security'])))).toBeNull();
  });

  it('lets dev and qa roles move only the status of an item they hold', () => {
    expect(refusal(job('dev-light', true), change(state('in-progress'), state('qa')))).toBeNull();
    expect(refusal(job('qa', true), change(state('qa'), state('done')))).toBeNull();
    expect(refusal(job('dev', false), change(state('in-progress'), state('qa')))).toEqual({
      type: 'transition-role',
      reason: 'item-not-held',
    });
    expect(refusal(job('dev', true), change(state('in-progress'), state('qa'), true))?.reason).toBe(
      'role-cannot-edit',
    );
    expect(
      refusal(job('dev', true), change(state('in-progress'), state('in-progress', ['needs-design'])))?.reason,
    ).toBe('role-cannot-edit');
    expect(
      refusal(job('qa', true), change(state('qa'), { status: 'qa', flags: [], closed: true }))?.reason,
    ).toBe('role-cannot-edit');
    expect(refusal(job('dev', true), change(null, state('proposed')))?.reason).toBe('role-cannot-edit');
  });

  it('lets the security role change flags and nothing else', () => {
    expect(refusal(job('security'), change(state('qa'), state('qa', ['release-blocker'])))).toBeNull();
    expect(refusal(job('security'), change(state('qa'), state('done')))?.reason).toBe('role-cannot-edit');
    expect(refusal(job('security'), change(state('qa'), state('qa'), true))?.reason).toBe('role-cannot-edit');
  });

  it('refuses every other role', () => {
    for (const role of ['analyst', 'scribe', 'ux-designer', 'devops', 'runner']) {
      expect(refusal(job(role, true), change(state('approved'), state('in-progress')))?.reason).toBe(
        'role-cannot-edit',
      );
    }
  });
});

describe('policyActorOf', () => {
  it('maps the owner and the local bypass to the owner, and the service identity to nothing', () => {
    expect(policyActorOf({ kind: 'user', email: 'owner@example.com' })).toEqual({ kind: 'owner' });
    expect(policyActorOf({ kind: 'local' })).toEqual({ kind: 'owner' });
    expect(policyActorOf({ kind: 'service', commonName: 'ci' })).toBeNull();
  });
});
