import type { ItemRecord } from '@worker/db';
import { planItemUpdate } from './item-change';

const AT = '2026-11-05T09:00:00.000Z';
const ITEM: ItemRecord = {
  id: 1,
  number: 7,
  kind: 'feature',
  status: 'in-progress',
  severity: null,
  tier: 'standard',
  sprintNumber: null,
  title: 'Title',
  body: 'Body',
  flags: ['needs-design'],
  closedAt: null,
  closedReason: null,
  approvedAt: AT,
  createdByKind: 'owner',
  createdBy: 'owner',
  createdAt: AT,
  updatedAt: AT,
  version: 3,
  source: 'console',
  sourceUrl: null,
};

describe('planItemUpdate', () => {
  it('records only the fields that change, before and after', () => {
    const outcome = planItemUpdate(ITEM, { title: 'New', tier: 'standard', kind: 'feature' }, undefined, AT);
    expect(outcome).toEqual({
      kind: 'change',
      plan: {
        patch: { title: 'New' },
        flags: { add: [], remove: [] },
        events: [{ kind: 'edited', before: { title: 'Title' }, after: { title: 'New' } }],
        transition: {
          before: { status: 'in-progress', flags: ['needs-design'], closed: false, approved: true },
          after: { status: 'in-progress', flags: ['needs-design'], closed: false, approved: true },
          changesText: true,
          changesPlanning: false,
          changesUnclassified: false,
        },
      },
    });
  });

  // #462: the transition table freezes the text after the approval and leaves planning to the editing roles.
  it('tells a text edit from a planning edit', () => {
    const text = (input: Parameters<typeof planItemUpdate>[1]) => {
      const outcome = planItemUpdate(ITEM, input, undefined, AT);
      return outcome.kind === 'change'
        ? [outcome.plan.transition.changesText, outcome.plan.transition.changesPlanning]
        : null;
    };
    expect(text({ body: 'New body' })).toEqual([true, false]);
    expect(text({ title: 'New' })).toEqual([true, false]);
    expect(text({ kind: 'feature', severity: 'high', tier: 'heavy' })).toEqual([false, true]);
    expect(text({ title: 'New', tier: 'heavy' })).toEqual([true, true]);
    expect(text({ status: 'qa', addLabels: ['security'] })).toEqual([false, false]);
    // Every field planItemUpdate records today is classified; a new one would fail closed for jobs.
    const everything = planItemUpdate(
      ITEM,
      {
        title: 'New',
        body: 'New body',
        kind: 'bug',
        severity: 'high',
        tier: 'heavy',
        status: 'done',
        addLabels: ['security'],
        removeLabels: ['needs-design'],
      },
      { id: 5, number: 2 },
      AT,
    );
    expect(everything).toMatchObject({ plan: { transition: { changesUnclassified: false } } });
    expect(planItemUpdate(ITEM, {}, { id: 5, number: 2 }, AT)).toMatchObject({
      plan: { transition: { changesText: false, changesPlanning: true } },
    });
  });

  it('writes nothing when the request asks for what the item already is', () => {
    expect(
      planItemUpdate(
        ITEM,
        { status: 'in-progress', addLabels: ['needs-design'], removeLabels: ['x'] },
        undefined,
        AT,
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  it('names a single status, flag or sprint change by its own event kind', () => {
    const kindOf = (outcome: ReturnType<typeof planItemUpdate>) =>
      outcome.kind === 'change' ? outcome.plan.events.map((event) => event.kind).join(',') : outcome.kind;
    expect(kindOf(planItemUpdate(ITEM, { status: 'qa' }, undefined, AT))).toBe('status');
    expect(kindOf(planItemUpdate(ITEM, { addLabels: ['security'] }, undefined, AT))).toBe('labels');
    expect(kindOf(planItemUpdate(ITEM, { sprint: 4 }, { id: 40, number: 4 }, AT))).toBe('sprint');
  });

  it('keeps the status in its own event when a change also edits other fields', () => {
    const outcome = planItemUpdate(
      ITEM,
      { title: 'New', status: 'qa', addLabels: ['security'] },
      undefined,
      AT,
    );
    expect(outcome).toMatchObject({
      kind: 'change',
      plan: {
        events: [
          { kind: 'status', before: { status: 'in-progress' }, after: { status: 'qa' } },
          {
            kind: 'edited',
            before: { title: 'Title', flags: ['needs-design'] },
            after: { title: 'New', flags: ['needs-design', 'security'] },
          },
        ],
      },
    });
    const closing = planItemUpdate(ITEM, { status: 'done', sprint: 4 }, { id: 40, number: 4 }, AT);
    expect(closing.kind === 'change' ? closing.plan.events.map((event) => event.kind) : []).toEqual([
      'closed',
      'sprint',
    ]);
  });

  it('closes on done and reopens when the status leaves done', () => {
    const closing = planItemUpdate(ITEM, { status: 'done' }, undefined, AT);
    expect(closing).toMatchObject({
      kind: 'change',
      plan: {
        patch: { status: 'done', closedAt: AT, closedReason: 'done' },
        events: [{ kind: 'closed' }],
        transition: { after: { closed: true }, changesText: false, changesPlanning: false },
      },
    });
    const done = { ...ITEM, status: 'done' as const, closedAt: AT, closedReason: 'done' as const };
    expect(planItemUpdate(done, { status: 'qa' }, undefined, AT)).toMatchObject({
      kind: 'change',
      plan: { patch: { status: 'qa', closedAt: null, closedReason: null }, events: [{ kind: 'reopened' }] },
    });
  });

  it('closes as not planned and reopens it, keeping the status', () => {
    const closing = planItemUpdate(ITEM, { state: 'closed', closedReason: 'not-planned' }, undefined, AT);
    expect(closing).toMatchObject({
      kind: 'change',
      plan: { patch: { closedAt: AT, closedReason: 'not-planned' }, events: [{ kind: 'closed' }] },
    });
    const closed = { ...ITEM, closedAt: AT, closedReason: 'not-planned' as const };
    expect(planItemUpdate(closed, { state: 'open' }, undefined, AT)).toMatchObject({
      kind: 'change',
      plan: { patch: { closedAt: null, closedReason: null }, events: [{ kind: 'reopened' }] },
    });
  });

  it('refuses to reopen a done item without another status', () => {
    const done = { ...ITEM, status: 'done' as const, closedAt: AT, closedReason: 'done' as const };
    expect(planItemUpdate(done, { state: 'open' }, undefined, AT)).toMatchObject({
      kind: 'invalid',
      field: 'status',
    });
    expect(planItemUpdate(done, { state: 'closed', closedReason: 'duplicate' }, undefined, AT)).toMatchObject(
      {
        kind: 'invalid',
        field: 'state',
      },
    );
  });

  it('hands the policy the flags after the change', () => {
    const outcome = planItemUpdate(
      ITEM,
      { addLabels: ['design:approved'], removeLabels: ['needs-design'] },
      undefined,
      AT,
    );
    expect(outcome).toMatchObject({
      kind: 'change',
      plan: {
        flags: { add: ['design:approved'], remove: ['needs-design'] },
        transition: { after: { flags: ['design:approved'] }, changesText: false, changesPlanning: false },
      },
    });
  });

  // #452: the approval is recorded with the first workable status, never by closing.
  describe('the approval', () => {
    const PROPOSED: ItemRecord = { ...ITEM, status: 'proposed', approvedAt: null };
    const LATER = '2026-11-06T09:00:00.000Z';
    const planOf = (item: ItemRecord, input: Parameters<typeof planItemUpdate>[1]) => {
      const outcome = planItemUpdate(item, input, undefined, LATER);
      if (outcome.kind !== 'change') {
        throw new Error(`expected a change, got ${outcome.kind}`);
      }
      return outcome.plan;
    };

    it.each(['approved', 'in-progress', 'qa', 'blocked'] as const)(
      'is set when the item becomes %s',
      (status) => {
        const plan = planOf(PROPOSED, { status });
        expect(plan.patch.approvedAt).toBe(LATER);
        expect(plan.transition.before?.approved).toBe(false);
        expect(plan.transition.after.approved).toBe(true);
      },
    );

    it('is not set by closing a proposed item as done or not planned', () => {
      expect(planOf(PROPOSED, { status: 'done' }).patch).not.toHaveProperty('approvedAt');
      expect(planOf(PROPOSED, { state: 'closed', closedReason: 'not-planned' }).patch).not.toHaveProperty(
        'approvedAt',
      );
    });

    it('is kept as it was on an approved item', () => {
      const plan = planOf(ITEM, { status: 'qa' });
      expect(plan.patch).not.toHaveProperty('approvedAt');
      expect(plan.transition.before?.approved).toBe(true);
    });
  });
});
