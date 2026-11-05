import type { ItemStatus } from '@shared/contracts';
import type { Identity } from './auth.types';
import type { DecisionCommand, Section } from '@shared/contracts';
import type { ItemRecord } from '@worker/db';
import { JOB_ROLES } from './job-roles';
import {
  askEffectOf,
  commentKindRefusal,
  decisionEffectOf,
  holdsItem,
  policyActorOf,
  transitionRefusal,
  type ItemPolicyState,
  type ItemTransition,
  type PolicyActor,
} from './policy';

// R5 of the #408 threat model: owner-semantic status and flags are the owner's alone; roles act within the table.

const OWNER: PolicyActor = { kind: 'owner' };
// Every transition below is on item 1; a job holds it when its payload names 1.
const job = (role: string, holdsItem = false): PolicyActor => ({
  kind: 'job',
  role,
  projectSlug: 'acme',
  jobId: 'job-test-1',
  items: holdsItem ? [1] : [],
});

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

const refusal = (actor: PolicyActor, transition: ItemTransition) =>
  transitionRefusal(actor, transition, transition.before === null ? null : 1);

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

  // #452: approval is not the one edge `proposed → approved`.
  it('refuses every job leaving proposed, or reaching approved, by any status', () => {
    const others = ['in-progress', 'qa', 'done', 'blocked'] as const;
    for (const role of JOB_ROLES) {
      for (const status of others) {
        expect(refusal(job(role, true), change(state('proposed'), state(status)))).toEqual({
          type: 'transition-owner-only',
          reason: 'leave-proposed',
        });
        expect(refusal(job(role, true), change(state(status), state('approved')))).toEqual({
          type: 'transition-owner-only',
          reason: 'approve',
        });
        expect(refusal(job(role), change(null, state(status)))).toEqual({
          type: 'transition-owner-only',
          reason: 'leave-proposed',
        });
      }
    }
  });

  it('leaves closing a proposed item as not planned or duplicate to the editing roles', () => {
    const closing = change(state('proposed'), { status: 'proposed', flags: [], closed: true });
    for (const role of ['pm', 'architect', 'orchestrator']) {
      expect(refusal(job(role), closing)).toBeNull();
    }
  });

  it('lets the owner make every one of those moves', () => {
    expect(refusal(OWNER, change(state('proposed'), state('blocked')))).toBeNull();
    expect(refusal(OWNER, change(state('blocked'), state('approved')))).toBeNull();
    expect(refusal(OWNER, change(null, state('in-progress')))).toBeNull();
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
  const local = { ENVIRONMENT: 'local', AUTH_MODE: 'local' };
  const deployed = { ENVIRONMENT: 'production' };

  it('maps the owner and the local bypass to the owner, and the service identity to nothing', () => {
    expect(policyActorOf({ kind: 'user', email: 'owner@example.com' }, deployed)).toEqual({ kind: 'owner' });
    expect(policyActorOf({ kind: 'local' }, local)).toEqual({ kind: 'owner' });
    expect(policyActorOf({ kind: 'service', commonName: 'ci' }, local)).toBeNull();
  });

  it('is an allowlist (#434): the local kind outside the bypass and an unknown kind map to nothing', () => {
    expect(policyActorOf({ kind: 'local' }, deployed)).toBeNull();
    expect(policyActorOf({ kind: 'local' }, { ENVIRONMENT: 'local' })).toBeNull();
    const futureKind = { kind: 'runner', runnerId: 'r1' } as unknown as Identity;
    expect(policyActorOf(futureKind, local)).toBeNull();
    expect(policyActorOf(futureKind, deployed)).toBeNull();
  });

  // #444: the job identity's only minter is the local stand-in, so it maps only while the local bypass holds.
  const job: Identity = { kind: 'job', role: 'qa', projectSlug: 'acme', jobId: 'job-9', items: [4, 7] };

  it('maps the job identity to the job actor under the local bypass', () => {
    expect(policyActorOf(job, local)).toEqual({
      kind: 'job',
      role: 'qa',
      projectSlug: 'acme',
      jobId: 'job-9',
      items: [4, 7],
    });
  });

  it.each([
    ['dev', { ENVIRONMENT: 'dev', AUTH_MODE: 'local' }],
    ['stage', { ENVIRONMENT: 'stage', AUTH_MODE: 'local' }],
    ['production', { ENVIRONMENT: 'production', AUTH_MODE: 'local' }],
    ['production without AUTH_MODE', { ENVIRONMENT: 'production' }],
    ['local without AUTH_MODE', { ENVIRONMENT: 'local' }],
    ['AUTH_MODE=local with an empty ENVIRONMENT', { ENVIRONMENT: '', AUTH_MODE: 'local' }],
  ])('maps the job identity to nothing on %s', (_, env) => {
    expect(policyActorOf(job, env)).toBeNull();
  });
});

describe('holdsItem', () => {
  it('is the payload’s item list, and never the owner’s or a new item’s', () => {
    expect(holdsItem(job('dev', true), 1)).toBe(true);
    expect(holdsItem(job('dev', true), 2)).toBe(false);
    expect(holdsItem(job('dev', true), null)).toBe(false);
    expect(holdsItem(OWNER, 1)).toBe(false);
  });
});

describe('R2: reviewer roles never write verdict-like state', () => {
  it.each(['qa:changes-requested', 'review-failed', 'tier-up'])(
    'refuses %s to qa, reviewer and security (set or cleared), leaves it to the orchestrator',
    (flag) => {
      const adding = change(state('in-progress'), state('in-progress', [flag]));
      const removing = change(state('in-progress', [flag]), state('in-progress'));
      for (const role of ['qa', 'reviewer', 'security']) {
        expect(refusal(job(role, true), adding)).toEqual({ type: 'transition-role', reason: 'verdict-flag' });
        expect(refusal(job(role, true), removing)?.reason).toBe('verdict-flag');
      }
      expect(refusal(job('orchestrator'), adding)).toBeNull();
      expect(refusal(job('orchestrator'), removing)).toBeNull();
      expect(refusal(OWNER, adding)).toBeNull();
    },
  );

  it('lets the reviewer role change nothing at all', () => {
    expect(refusal(job('reviewer', true), change(state('qa'), state('done')))?.reason).toBe(
      'role-cannot-edit',
    );
    expect(refusal(job('reviewer', true), change(state('qa'), state('qa', ['security'])))?.reason).toBe(
      'role-cannot-edit',
    );
    expect(refusal(job('reviewer'), change(null, state('proposed')))?.reason).toBe('role-cannot-edit');
  });
});

describe('commentKindRefusal', () => {
  it('lets the owner write comments only', () => {
    expect(commentKindRefusal(OWNER, 'comment')).toBeNull();
    expect(commentKindRefusal(OWNER, 'note')).toEqual({ type: 'comment-kind', reason: 'note' });
    expect(commentKindRefusal(OWNER, 'decision')).toEqual({ type: 'comment-kind', reason: 'decision' });
  });

  it('lets every role write each kind, except a team decision as dev-light', () => {
    for (const role of [
      'pm',
      'architect',
      'orchestrator',
      'dev',
      'dev-heavy',
      'qa',
      'reviewer',
      'security',
    ]) {
      for (const kind of ['comment', 'note', 'decision'] as const) {
        expect(commentKindRefusal(job(role), kind)).toBeNull();
      }
    }
    expect(commentKindRefusal(job('dev-light'), 'decision')).toEqual({
      type: 'comment-kind',
      reason: 'decision',
    });
    expect(commentKindRefusal(job('dev-light'), 'note')).toBeNull();
  });
});

// #434 §5: every (section, command) cell of the decision table. A cell not named is `null` (the row and its event).
describe('decisionEffectOf', () => {
  const proposed = { status: 'proposed' } as const;
  const inProgress = { status: 'in-progress' } as const;
  const commands: readonly DecisionCommand[] = [
    'approve',
    'reject',
    'go',
    'no-go',
    'done',
    'override',
    'resume',
  ];
  const expected: Record<Section, Partial<Record<DecisionCommand, unknown>>> = {
    question: { approve: { status: 'approved' } },
    design: {
      approve: {
        status: 'approved',
        addLabels: ['design:approved'],
        removeLabels: ['design:awaiting-approval'],
      },
      reject: { removeLabels: ['design:awaiting-approval'] },
    },
    release: { go: { status: 'done' }, 'no-go': { status: 'done' }, override: { status: 'done' } },
    owner: { done: { removeLabels: ['needs:owner'] } },
    local: { done: { removeLabels: ['needs:local'] } },
  };
  const cells = (Object.keys(expected) as Section[]).flatMap((section) =>
    commands.map((command) => [section, command, expected[section][command] ?? null] as const),
  );

  it.each(cells)('%s + %s on a proposed item → %j', (section, command, effect) => {
    expect(decisionEffectOf(section, command, proposed)).toEqual(effect);
  });

  it('approves only a proposed item; past it, approve changes the status of nothing', () => {
    expect(decisionEffectOf('question', 'approve', inProgress)).toBeNull();
    expect(decisionEffectOf('design', 'approve', inProgress)).toEqual({
      addLabels: ['design:approved'],
      removeLabels: ['design:awaiting-approval'],
    });
  });
});

describe('askEffectOf', () => {
  const AT = '2026-11-05T09:00:00.000Z';
  const item = (flags: string[]): ItemRecord => ({
    id: 1,
    number: 7,
    kind: 'feature',
    status: 'in-progress',
    severity: null,
    tier: null,
    sprintNumber: null,
    title: 'T',
    body: '',
    flags,
    closedAt: null,
    closedReason: null,
    createdByKind: 'owner',
    createdBy: 'owner',
    createdAt: AT,
    updatedAt: AT,
    version: 2,
    source: 'console',
    sourceUrl: null,
  });

  it('sets owner:<category> and removes any other owner flag, nothing else', () => {
    const plan = askEffectOf(item(['needs:owner', 'owner:scope', 'security']), 'money', AT);
    expect(plan?.flags).toEqual({ add: ['owner:money'], remove: ['owner:scope'] });
    expect(plan?.patch).toEqual({});
    expect(plan?.events.map((event) => event.kind)).toEqual(['labels']);
    expect(plan?.transition.after.flags).toEqual(['needs:owner', 'owner:money', 'security']);
  });

  it('keeps the kind: an ask on a feature stays a feature', () => {
    expect(askEffectOf(item([]), 'scope', AT)?.patch).toEqual({});
  });

  it('is null when the item already carries exactly that flag', () => {
    expect(askEffectOf(item(['owner:legal']), 'legal', AT)).toBeNull();
  });

  it('is an effect a job could never make by PATCH (the R5 exception is the ask row)', () => {
    const plan = askEffectOf(item([]), 'design', AT);
    expect(plan).not.toBeNull();
    expect(transitionRefusal(job('pm'), plan?.transition ?? change(null, state('proposed')), 7)).toEqual({
      type: 'transition-owner-only',
      reason: 'owner-flag',
    });
  });
});
