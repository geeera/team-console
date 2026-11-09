import type { ItemStatus } from '@shared/contracts';
import type { Identity } from './auth.types';
import type { DecisionCommand, Section } from '@shared/contracts';
import type { ItemRecord } from '@worker/db';
import { EDITING_ROLES, JOB_ROLES, type JobRole } from './job-roles';
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
  type TransitionRefusal,
} from './policy';

// R5 of the #408 threat model: owner-semantic status and flags are the owner's alone; roles act within the table.

const OWNER: PolicyActor = { kind: 'owner' };
// Every transition below is on item 1; a job holds it when its payload names 1.
const job = (role: JobRole, holdsItem = false): PolicyActor => ({
  kind: 'job',
  role,
  projectSlug: 'acme',
  jobId: 'job-test-1',
  items: holdsItem ? [1] : [],
});

// By default an item past `proposed` carries its approval; `unapproved` builds the exceptions.
function state(status: ItemStatus, flags: string[] = [], closed = status === 'done'): ItemPolicyState {
  return { status, flags, closed, approved: status !== 'proposed' };
}

const unapproved = (state: ItemPolicyState): ItemPolicyState => ({ ...state, approved: false });

/** `edits`: which other fields the change touches besides status and flags. */
function change(
  before: ItemPolicyState | null,
  after: ItemPolicyState,
  edits: 'none' | 'planning' | 'text' = 'none',
): ItemTransition {
  return { before, after, changesText: edits === 'text', changesPlanning: edits === 'planning' };
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
      change(state('qa', ['team:demo']), state('qa', ['team:demo'], true)),
    ],
  ];

  it.each(cases)('%s is refused to every role, PM and orchestrator included', (_, transition) => {
    for (const role of ['pm', 'architect', 'orchestrator', 'security', 'dev', 'qa'] as const) {
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
    const closing = change(state('proposed'), state('proposed', [], true));
    for (const role of EDITING_ROLES) {
      expect(refusal(job(role), closing)).toBeNull();
    }
  });

  // Security review of #458: the release decision closes a proposed demo item as done, never approving it.
  it('lets no job take an unapproved done item into work, only back to proposed', () => {
    const released = unapproved(state('done', ['team:demo']));
    for (const role of JOB_ROLES) {
      for (const status of ['in-progress', 'qa', 'blocked'] as const) {
        expect(refusal(job(role, true), change(released, state(status, ['team:demo'])))).toEqual({
          type: 'transition-owner-only',
          reason: 'not-approved',
        });
      }
      expect(refusal(job(role, true), change(released, state('approved', ['team:demo'])))?.reason).toBe(
        'approve',
      );
    }
    expect(refusal(job('pm'), change(released, state('proposed', ['team:demo'])))).toBeNull();
    expect(refusal(OWNER, change(released, state('in-progress', ['team:demo'])))).toBeNull();
  });

  it('keeps reopening an approved, closed item to the roles that may today', () => {
    const closed = state('done');
    expect(refusal(job('pm'), change(closed, state('in-progress')))).toBeNull();
    expect(refusal(job('dev', true), change(closed, state('in-progress')))).toBeNull();
    expect(refusal(job('analyst', true), change(closed, state('in-progress')))?.reason).toBe(
      'role-cannot-edit',
    );
  });

  it('keeps team:demo on a closed item', () => {
    const closed = state('done', ['team:demo']);
    for (const role of JOB_ROLES) {
      expect(refusal(job(role, true), change(closed, state('done')))).toEqual({
        type: 'transition-owner-only',
        reason: 'demo-flag',
      });
    }
    expect(refusal(OWNER, change(closed, state('done')))).toBeNull();
    expect(refusal(job('pm'), change(state('qa', ['team:demo']), state('qa')))).toBeNull();
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
    for (const role of EDITING_ROLES) {
      expect(refusal(job(role), change(null, state('proposed', ['needs-design'])))).toBeNull();
      expect(refusal(job(role), change(state('proposed'), state('proposed'), 'planning'))).toBeNull();
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
    expect(refusal(job('dev', true), change(state('in-progress'), state('qa'), 'planning'))?.reason).toBe(
      'role-cannot-edit',
    );
    expect(
      refusal(job('dev', true), change(state('in-progress'), state('in-progress', ['needs-design'])))?.reason,
    ).toBe('role-cannot-edit');
    expect(refusal(job('qa', true), change(state('qa'), state('qa', [], true)))?.reason).toBe(
      'role-cannot-edit',
    );
    expect(refusal(job('dev', true), change(null, state('proposed')))?.reason).toBe('role-cannot-edit');
  });

  it('lets the security role change flags and nothing else', () => {
    expect(refusal(job('security'), change(state('qa'), state('qa', ['release-blocker'])))).toBeNull();
    expect(refusal(job('security'), change(state('qa'), state('done')))?.reason).toBe('role-cannot-edit');
    expect(refusal(job('security'), change(state('qa'), state('qa'), 'planning'))?.reason).toBe(
      'role-cannot-edit',
    );
  });

  it('refuses every other role', () => {
    for (const role of ['analyst', 'scribe', 'ux-designer', 'ui-designer', 'devops'] as const) {
      expect(refusal(job(role, true), change(state('approved'), state('in-progress')))?.reason).toBe(
        'role-cannot-edit',
      );
    }
  });
});

// #462 (ADR 0008 row 2-0): the text the owner approved is frozen for jobs; planning goes on after the approval.
describe('transition table: edit-after-approval', () => {
  it.each(JOB_ROLES)('refuses %s a title or body edit of an approved item, held or not', (role) => {
    for (const held of [true, false]) {
      for (const status of ['approved', 'in-progress', 'qa', 'blocked', 'done'] as const) {
        expect(refusal(job(role, held), change(state(status), state(status), 'text'))).toEqual({
          type: 'transition-owner-only',
          reason: 'edit-after-approval',
        });
      }
    }
  });

  it('refuses the text edit even when the same change also moves the status or plans', () => {
    const textAndMove: ItemTransition = {
      before: state('approved'),
      after: state('in-progress'),
      changesText: true,
      changesPlanning: true,
    };
    for (const role of JOB_ROLES) {
      expect(refusal(job(role, true), textAndMove)?.reason).toBe('edit-after-approval');
    }
  });

  it('keeps kind, severity, tier and sprint editable by the editing roles after the approval', () => {
    for (const role of EDITING_ROLES) {
      for (const status of ['approved', 'in-progress', 'qa', 'blocked'] as const) {
        expect(refusal(job(role), change(state(status), state(status), 'planning'))).toBeNull();
      }
    }
  });

  it('lets the editing roles edit the text while the item is not approved', () => {
    for (const role of EDITING_ROLES) {
      expect(refusal(job(role), change(state('proposed'), state('proposed'), 'text'))).toBeNull();
      // The release decision closes a demo item without approving it: its text is not an approved text.
      const released = unapproved(state('done', ['team:demo']));
      expect(refusal(job(role), change(released, released, 'text'))).toBeNull();
    }
  });

  it('leaves the owner free to correct an approved text', () => {
    expect(refusal(OWNER, change(state('in-progress'), state('in-progress'), 'text'))).toBeNull();
  });
});

type Verdict = TransitionRefusal['reason'] | null;

/** The role-dependent cases of the table, each on item 1 (`held`: the job holds it). */
const ROLE_CASES = {
  textAfterApproval: change(state('approved'), state('approved'), 'text'),
  planningAfterApproval: change(state('approved'), state('approved'), 'planning'),
  textBeforeApproval: change(state('proposed'), state('proposed'), 'text'),
  create: change(null, state('proposed')),
  moveHeld: change(state('approved'), state('in-progress')),
  moveNotHeld: change(state('approved'), state('in-progress')),
  flag: change(state('approved'), state('approved', ['needs-design'])),
  verdictFlag: change(state('qa'), state('qa', ['review-failed'])),
  removeGuard: change(state('qa', ['release-blocker']), state('qa')),
  workflowChange: change(state('approved'), state('approved', ['workflow-change'])),
} as const satisfies Record<string, ItemTransition>;

type RoleCase = keyof typeof ROLE_CASES;

const C = 'role-cannot-edit';
const FROZEN = 'edit-after-approval';
const EDITOR = {
  textAfterApproval: FROZEN,
  planningAfterApproval: null,
  textBeforeApproval: null,
  create: null,
  moveHeld: null,
  moveNotHeld: null,
  flag: null,
  verdictFlag: null,
  removeGuard: 'remove-guard-flag',
  workflowChange: 'workflow-change',
} as const satisfies Record<RoleCase, Verdict>;
const DEVELOPER = {
  textAfterApproval: FROZEN,
  planningAfterApproval: C,
  textBeforeApproval: C,
  create: C,
  moveHeld: null,
  moveNotHeld: 'item-not-held',
  flag: C,
  verdictFlag: C,
  removeGuard: 'remove-guard-flag',
  workflowChange: 'workflow-change',
} as const satisfies Record<RoleCase, Verdict>;
const NO_EDITS = {
  ...DEVELOPER,
  moveHeld: C,
  moveNotHeld: C,
} as const satisfies Record<RoleCase, Verdict>;

// A `Record<JobRole, …>`: a role added to JOB_ROLES does not compile here until every case is decided for it.
const DECIDED: Readonly<Record<JobRole, Readonly<Record<RoleCase, Verdict>>>> = {
  pm: { ...EDITOR, removeGuard: null },
  architect: EDITOR,
  orchestrator: EDITOR,
  dev: DEVELOPER,
  'dev-light': DEVELOPER,
  'dev-heavy': DEVELOPER,
  qa: { ...DEVELOPER, verdictFlag: 'verdict-flag' },
  reviewer: { ...NO_EDITS, verdictFlag: 'verdict-flag' },
  security: { ...NO_EDITS, flag: null, verdictFlag: 'verdict-flag', removeGuard: null, workflowChange: null },
  devops: NO_EDITS,
  analyst: NO_EDITS,
  scribe: NO_EDITS,
  'ux-designer': NO_EDITS,
  'ui-designer': NO_EDITS,
};

describe('transition table: every role decided on every role-dependent case', () => {
  const cells = JOB_ROLES.flatMap((role) =>
    (Object.keys(ROLE_CASES) as RoleCase[]).map((name) => [role, name] as const),
  );

  it.each(cells)('%s on %s', (role, name) => {
    const held = name !== 'moveNotHeld';
    const outcome = transitionRefusal(
      job(role, held),
      ROLE_CASES[name],
      ROLE_CASES[name].before === null ? null : 1,
    );
    expect(outcome?.reason ?? null).toBe(DECIDED[role][name]);
  });

  it('lets the owner make every one of them', () => {
    for (const transition of Object.values(ROLE_CASES)) {
      expect(refusal(OWNER, transition)).toBeNull();
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
      for (const role of ['qa', 'reviewer', 'security'] as const) {
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
    for (const role of JOB_ROLES.filter((each) => each !== 'dev-light')) {
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
    approvedAt: AT,
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
