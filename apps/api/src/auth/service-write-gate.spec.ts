import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { isProblemDetails, problemSlugOf } from '@shared/contracts';
import { createWorkerApp } from '@worker/core';
import { parseRepoName } from '@worker/github';
import type { ApiEnv } from '../env';
import type { Identity } from './auth.types';
import { ACCESS_OWNER_MEMBERSHIPS } from './scope';
import {
  FIXTURE_LABEL,
  fixtureLabellerOf,
  fixtureProvenanceRefusal,
  isIssueEventsPage,
  labelRefusal,
  refuseServiceWrite,
  refuseServiceWriteOnRecheck,
} from './service-write-gate';

// #62 and #193: which issues the Access service identity may write on as the owner. The route wiring is in
// answer.spec.ts.

const OWNER_ID = 1001;
const OWNER = { login: 'geeera', id: OWNER_ID, type: 'User' } as const;
const TEAM_BOT = { login: 'team-console-team[bot]', id: 335634318, type: 'Bot' } as const;

let nextId = 1000;

function event(
  kind: 'labeled' | 'unlabeled',
  actor: Readonly<Record<string, unknown>> | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  nextId += 1;
  return {
    id: nextId,
    event: kind,
    actor,
    label: { name: FIXTURE_LABEL, color: 'ededed' },
    performed_via_github_app: null,
    created_at: '2026-10-05T10:00:00Z',
    ...extra,
  };
}

const whole = (items: Record<string, unknown>[]) => ({ items, isWholeList: true });

describe('labelRefusal', () => {
  it('uses the e2e:fixture label', () => {
    expect(FIXTURE_LABEL).toBe('e2e:fixture');
  });

  it('refuses an issue without the fixture label', () => {
    expect(labelRefusal(['needs:owner', 'kind:chore'])).toEqual({
      type: 'service-not-fixture',
      reason: 'no-fixture-label',
    });
  });

  it('refuses a label that only looks like the fixture label', () => {
    for (const label of ['E2E:fixture', 'e2e:fixture ', 'e2e:fixtures', 'e2e']) {
      expect(labelRefusal(['needs:owner', label])?.type).toBe('service-not-fixture');
    }
  });

  it.each([
    [['needs:owner', FIXTURE_LABEL]],
    [['needs:local', FIXTURE_LABEL]],
    [['kind:chore', FIXTURE_LABEL]],
  ])('lets the labels of %j through to the history check', (labels) => {
    expect(labelRefusal(labels)).toBeNull();
  });

  it.each([
    [['team:demo', FIXTURE_LABEL], 'release'],
    [['team:demo', 'needs:owner', FIXTURE_LABEL], 'release'],
    [['design:awaiting-approval', FIXTURE_LABEL], 'design'],
    [['design:approved', 'kind:question', FIXTURE_LABEL], 'design'],
    [['design:anything-new', FIXTURE_LABEL], 'design'],
    // #193: every question, whoever opened it — in same_account mode the team asks as the owner.
    [['kind:question', FIXTURE_LABEL], 'question'],
    [['kind:question', 'owner:scope', FIXTURE_LABEL], 'question'],
  ] as const)('refuses %j even with the fixture label (%s)', (labels, reason) => {
    expect(labelRefusal(labels)).toEqual({ type: 'service-protected-item', reason });
  });

  it('names the protection, not the missing label, on a protected issue without the fixture label', () => {
    expect(labelRefusal(['team:demo'])?.type).toBe('service-protected-item');
    expect(labelRefusal(['kind:question'])?.type).toBe('service-protected-item');
  });
});

describe('fixtureProvenanceRefusal (#193)', () => {
  const notByOwner = { type: 'service-not-fixture', reason: 'fixture-not-labelled-by-owner' } as const;

  it('allows a label the connected owner added', () => {
    expect(fixtureProvenanceRefusal(whole([event('labeled', OWNER)]), OWNER_ID)).toBeNull();
  });

  it('allows the owner under a renamed login: the pinned id decides, not the login', () => {
    const renamed = { login: 'geeera-renamed', id: OWNER_ID, type: 'User' };
    expect(fixtureProvenanceRefusal(whole([event('labeled', renamed)]), OWNER_ID)).toBeNull();
  });

  it("refuses the owner's login on another account id (a login given up and registered again)", () => {
    const impostor = { login: 'geeera', id: OWNER_ID + 1, type: 'User' };
    expect(fixtureProvenanceRefusal(whole([event('labeled', impostor)]), OWNER_ID)).toEqual(notByOwner);
  });

  it('refuses when no owner connection exists in the environment', () => {
    expect(fixtureProvenanceRefusal(whole([event('labeled', OWNER)]), null)).toEqual({
      type: 'service-not-fixture',
      reason: 'fixture-owner-not-connected',
    });
  });

  it('ignores other events and labels', () => {
    const history = whole([
      { id: 1, event: 'opened', actor: TEAM_BOT },
      event('labeled', OWNER),
      event('labeled', TEAM_BOT, { label: { name: 'needs:owner' } }),
      event('unlabeled', TEAM_BOT, { label: { name: 'e2e:fixtures' } }),
      { id: 999_999, event: 'commented', actor: TEAM_BOT },
    ]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toBeNull();
  });

  it.each([
    ['the team bot', TEAM_BOT],
    ['the review app', { login: 'team-console-review[bot]', id: 7, type: 'Bot' }],
    ['a bot with the owner id', { login: 'geeera', id: OWNER_ID, type: 'Bot' }],
    ['an organisation with the owner id', { login: 'geeera', id: OWNER_ID, type: 'Organization' }],
    ['another user', { login: 'outsider', id: 4242, type: 'User' }],
    ['a deleted account', null],
    ['an actor without a type', { login: 'geeera', id: OWNER_ID }],
    ['an actor without an id', { login: 'geeera', type: 'User' }],
    ['an actor with a string id', { login: 'geeera', id: String(OWNER_ID), type: 'User' }],
  ] as const)('refuses a label added by %s', (_who, actor) => {
    expect(fixtureProvenanceRefusal(whole([event('labeled', actor)]), OWNER_ID)).toEqual(notByOwner);
  });

  it("refuses the owner's account acting through a GitHub App's user token", () => {
    const history = whole([
      event('labeled', OWNER, { performed_via_github_app: { id: 1, slug: 'some-app' } }),
    ]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toEqual(notByOwner);
  });

  it('refuses when the owner added it and a bot removed and re-added it', () => {
    const history = whole([
      event('labeled', OWNER),
      event('unlabeled', TEAM_BOT),
      event('labeled', TEAM_BOT),
    ]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toEqual(notByOwner);
  });

  it('refuses when a bot re-labelled after the owner without removing it first', () => {
    const history = whole([event('labeled', OWNER), event('labeled', TEAM_BOT)]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toEqual(notByOwner);
  });

  it('allows when a bot labelled first and the owner labelled last', () => {
    const history = whole([event('labeled', TEAM_BOT), event('unlabeled', OWNER), event('labeled', OWNER)]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toBeNull();
  });

  it.each([OWNER, TEAM_BOT])('refuses when the label was removed afterwards (by %j)', (remover) => {
    const history = whole([event('labeled', OWNER), event('unlabeled', remover)]);
    expect(fixtureProvenanceRefusal(history, OWNER_ID)).toEqual({
      type: 'service-not-fixture',
      reason: 'fixture-label-removed',
    });
  });

  it('refuses a history with no labeled event, whole or a partial tail', () => {
    expect(fixtureProvenanceRefusal(whole([]), OWNER_ID)).toEqual(notByOwner);
    expect(
      fixtureProvenanceRefusal({ items: [{ id: 5, event: 'commented' }], isWholeList: false }, OWNER_ID),
    ).toEqual(notByOwner);
  });

  it('allows a partial tail whose newest fixture event is the owner adding it', () => {
    expect(
      fixtureProvenanceRefusal({ items: [event('labeled', OWNER)], isWholeList: false }, OWNER_ID),
    ).toBeNull();
  });

  it('refuses events whose order cannot be told', () => {
    const unreadable = { type: 'service-not-fixture', reason: 'fixture-history-unreadable' } as const;
    const late = event('labeled', TEAM_BOT);
    const early = event('labeled', OWNER, { id: Number(late['id']) - 1 });
    expect(fixtureProvenanceRefusal(whole([late, early]), OWNER_ID)).toEqual(unreadable);
    expect(fixtureProvenanceRefusal(whole([event('labeled', OWNER, { id: '7' })]), OWNER_ID)).toEqual(
      unreadable,
    );
    expect(fixtureProvenanceRefusal(whole([event('labeled', OWNER, { id: undefined })]), OWNER_ID)).toEqual(
      unreadable,
    );
  });

  it('names the labeller before any owner id is needed', () => {
    expect(fixtureLabellerOf(whole([event('labeled', OWNER)]))).toEqual({ labelledBy: OWNER_ID });
    expect(fixtureLabellerOf(whole([event('labeled', TEAM_BOT)]))).toEqual(notByOwner);
  });
});

describe('isIssueEventsPage (#193)', () => {
  const REPO = parseRepoName('geeera/team-console');
  const page = (path: string): URL => new URL(`https://api.github.com${path}`);

  it.each([
    '/repos/geeera/team-console/issues/72/events?per_page=100&page=3',
    '/repos/Geeera/Team-Console/issues/72/events?page=2',
    '/repos/geeera/team%2Dconsole/issues/72/events?page=2',
    '/repositories/1066011234/issues/72/events?per_page=100&page=3',
  ])('accepts %s as a page of issue #72 events', (path) => {
    expect(isIssueEventsPage(page(path), REPO, 72)).toBe(true);
  });

  it.each([
    '/repos/geeera/team-console/issues/73/events?page=2',
    '/repos/geeera/other-repo/issues/72/events?page=2',
    '/repos/someone/team-console/issues/72/events?page=2',
    '/repos/geeera/team-console/issues/72/comments?page=2',
    '/repos/geeera/team-console/issues/72/timeline?page=2',
    '/repos/geeera/team-console/issues/72/events/extra?page=2',
    '/repos/geeera/team-console/issues/072/events?page=2',
    '/repositories/1066011234/issues/73/events?page=2',
    '/repositories/abc/issues/72/events?page=2',
    '/repositories/0/issues/72/events?page=2',
    '/repos/geeera/team-console/issues/72/events/',
    '/repos/geeera/team%E0%A4%A/issues/72/events',
    '/app/installations',
  ])('refuses %s', (path) => {
    expect(isIssueEventsPage(page(path), REPO, 72)).toBe(false);
  });
});

// #443 (security review of #438, finding 1): the answer route is not behind ownerOnlyMiddleware, so these two
// functions are its identity check. The owner passes, the service identity is gated, every other kind is 403.
describe('refuseServiceWrite and its recheck by identity kind (#443)', () => {
  const FUTURE_KIND = { kind: 'job', role: 'pm' } as unknown as Identity;
  const FIXTURE_LABELS = ['needs:owner', 'kind:chore', FIXTURE_LABEL];
  const deployed: ApiEnv = { ...env, ENVIRONMENT: 'dev', AUTH_MODE: '' };
  const local: ApiEnv = { ...env, ENVIRONMENT: 'local', AUTH_MODE: 'local' };

  /** Both gates on a fixture issue the owner labelled; `reads` counts every read the gates make. */
  async function probe(
    identity: Identity,
    bindings: ApiEnv,
  ): Promise<{ first: Response; recheck: Response; reads: string[] }> {
    const reads: string[] = [];
    const app = createWorkerApp<ApiEnv>({ service: 'service-write-gate-probe', logSink: () => undefined });
    app.use('*', async (c, next) => {
      c.set('identity', identity);
      await next();
    });
    app.post('/first', async (c) => {
      const refused = await refuseServiceWrite(c, FIXTURE_LABELS, {
        labelHistory: async () => {
          reads.push('history');
          return whole([event('labeled', OWNER)]);
        },
        ownerUserId: async () => {
          reads.push('owner');
          return OWNER_ID;
        },
      });
      return refused ?? c.json({ allowed: true });
    });
    app.post('/recheck', async (c) => {
      const refused = await refuseServiceWriteOnRecheck(c, async () => {
        reads.push('labels');
        return FIXTURE_LABELS;
      });
      return refused ?? c.json({ allowed: true });
    });
    const send = async (path: string): Promise<Response> => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request(`http://api.test${path}`, { method: 'POST' }),
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    return { first: await send('/first'), recheck: await send('/recheck'), reads };
  }

  async function slugOf(response: Response): Promise<string | null> {
    const body: unknown = await response.json();
    return isProblemDetails(body) ? problemSlugOf(body.type) : null;
  }

  it('passes the owner without a single read', async () => {
    const { first, recheck, reads } = await probe({ kind: 'user', door: 'access', userId: null, memberships: ACCESS_OWNER_MEMBERSHIPS }, deployed);
    expect([first.status, recheck.status]).toEqual([200, 200]);
    expect(reads).toEqual([]);
  });

  it('passes the local bypass only while ENVIRONMENT=local and AUTH_MODE=local', async () => {
    const allowed = await probe({ kind: 'local' }, local);
    expect([allowed.first.status, allowed.recheck.status]).toEqual([200, 200]);
    const forged = await probe({ kind: 'local' }, deployed);
    expect([forged.first.status, forged.recheck.status]).toEqual([403, 403]);
    expect(await slugOf(forged.first)).toBe('owner-only');
    expect(await slugOf(forged.recheck)).toBe('owner-only');
    expect(forged.reads).toEqual([]);
  });

  it('runs the fixture gate for the service identity', async () => {
    const { first, recheck, reads } = await probe({ kind: 'service', commonName: 'ci' }, deployed);
    expect([first.status, recheck.status]).toEqual([200, 200]);
    expect(reads).toEqual(['history', 'owner', 'labels']);
  });

  it('refuses any other kind (the Phase 2 job identity) with 403 owner-only, before any read', async () => {
    const { first, recheck, reads } = await probe(FUTURE_KIND, deployed);
    expect([first.status, recheck.status]).toEqual([403, 403]);
    expect(await slugOf(first)).toBe('owner-only');
    expect(await slugOf(recheck)).toBe('owner-only');
    expect(reads).toEqual([]);
  });
});
