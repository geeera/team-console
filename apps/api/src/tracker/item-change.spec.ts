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
        event: { kind: 'edited', before: { title: 'Title' }, after: { title: 'New' } },
        transition: {
          before: { status: 'in-progress', flags: ['needs-design'], closed: false },
          after: { status: 'in-progress', flags: ['needs-design'], closed: false },
          changesOtherFields: true,
        },
      },
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
      outcome.kind === 'change' ? outcome.plan.event.kind : outcome.kind;
    expect(kindOf(planItemUpdate(ITEM, { status: 'qa' }, undefined, AT))).toBe('status');
    expect(kindOf(planItemUpdate(ITEM, { addLabels: ['security'] }, undefined, AT))).toBe('labels');
    expect(kindOf(planItemUpdate(ITEM, { sprint: 4 }, { id: 40, number: 4 }, AT))).toBe('sprint');
  });

  it('closes on done and reopens when the status leaves done', () => {
    const closing = planItemUpdate(ITEM, { status: 'done' }, undefined, AT);
    expect(closing).toMatchObject({
      kind: 'change',
      plan: {
        patch: { status: 'done', closedAt: AT, closedReason: 'done' },
        event: { kind: 'closed' },
        transition: { after: { closed: true }, changesOtherFields: false },
      },
    });
    const done = { ...ITEM, status: 'done' as const, closedAt: AT, closedReason: 'done' as const };
    expect(planItemUpdate(done, { status: 'qa' }, undefined, AT)).toMatchObject({
      kind: 'change',
      plan: { patch: { status: 'qa', closedAt: null, closedReason: null }, event: { kind: 'reopened' } },
    });
  });

  it('closes as not planned and reopens it, keeping the status', () => {
    const closing = planItemUpdate(ITEM, { state: 'closed', closedReason: 'not-planned' }, undefined, AT);
    expect(closing).toMatchObject({
      kind: 'change',
      plan: { patch: { closedAt: AT, closedReason: 'not-planned' }, event: { kind: 'closed' } },
    });
    const closed = { ...ITEM, closedAt: AT, closedReason: 'not-planned' as const };
    expect(planItemUpdate(closed, { state: 'open' }, undefined, AT)).toMatchObject({
      kind: 'change',
      plan: { patch: { closedAt: null, closedReason: null }, event: { kind: 'reopened' } },
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
        transition: { after: { flags: ['design:approved'] }, changesOtherFields: false },
      },
    });
  });
});
