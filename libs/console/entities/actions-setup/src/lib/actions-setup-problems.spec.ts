import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { actionsCheckProblemOf, workflowPrRefusalOf } from './actions-setup-problems';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');

function problem(
  status: number,
  slug: string | null,
  extensions: Record<string, unknown> = {},
  retryAfter?: string,
): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    headers: retryAfter === undefined ? new HttpHeaders() : new HttpHeaders({ 'Retry-After': retryAfter }),
    error:
      slug === null
        ? null
        : {
            type: `https://team-console/problems/${slug}`,
            title: 't',
            status,
            detail: 'never shown',
            ...extensions,
          },
  });
}

describe('actionsCheckProblemOf', () => {
  it.each([
    [problem(0, null), { kind: 'offline' }],
    [problem(403, 'owner-only'), { kind: 'forbidden' }],
    [problem(404, 'project-not-found'), { kind: 'not-found' }],
    [problem(502, 'github-unavailable'), { kind: 'github' }],
    [problem(502, null), { kind: 'failed' }],
    [problem(503, 'console-origin-misconfigured'), { kind: 'misconfigured' }],
    [problem(422, 'dispatch-repository-unverified'), { kind: 'unverified' }],
    [problem(500, null), { kind: 'failed' }],
  ])('maps %#', (error, expected) => {
    expect(actionsCheckProblemOf(error, NOW)).toEqual(expected);
  });

  it('reads the retry time from Retry-After, else a minute', () => {
    expect(actionsCheckProblemOf(problem(429, 'rate-limited', {}, '120'), NOW)).toEqual({
      kind: 'rate',
      retryAt: '2026-11-21T12:02:00.000Z',
    });
    expect(actionsCheckProblemOf(problem(429, 'rate-limited'), NOW)).toEqual({
      kind: 'rate',
      retryAt: '2026-11-21T12:01:00.000Z',
    });
  });

  it('treats a timeout or a non-HTTP error as failed', () => {
    expect(actionsCheckProblemOf(new TimeoutError(), NOW)).toEqual({ kind: 'failed' });
    expect(actionsCheckProblemOf(new Error('bug'), NOW)).toEqual({ kind: 'failed' });
  });
});

describe('workflowPrRefusalOf', () => {
  const PR_URL = 'https://github.com/geeera/storify/pull/42';
  const BRANCH_URL = 'https://github.com/geeera/storify/branches/all?query=team-console%2Frunner-';

  it('keeps the open PR with its provenance', () => {
    expect(
      workflowPrRefusalOf(
        problem(409, 'actions-setup-pr-open', { number: 42, url: PR_URL, provenance: 'foreign' }),
      ),
    ).toEqual({
      kind: 'pr-open',
      pr: { number: 42, url: PR_URL, provenance: 'foreign' },
    });
  });

  it('drops a PR that is not on github.com or has an unknown provenance', () => {
    expect(
      workflowPrRefusalOf(
        problem(409, 'actions-setup-pr-open', {
          number: 42,
          url: 'https://evil.example/pr',
          provenance: 'console',
        }),
      ),
    ).toEqual({ kind: 'pr-open', pr: null });
    expect(
      workflowPrRefusalOf(
        problem(409, 'actions-setup-pr-open', { number: 42, url: PR_URL, provenance: 'mine' }),
      ),
    ).toEqual({ kind: 'pr-open', pr: null });
  });

  it('keeps the branch link of branch-exists only on github.com (#844)', () => {
    expect(workflowPrRefusalOf(problem(409, 'actions-setup-branch-exists', { link: BRANCH_URL }))).toEqual({
      kind: 'branch-exists',
      link: BRANCH_URL,
    });
    expect(
      workflowPrRefusalOf(problem(409, 'actions-setup-branch-exists', { link: 'javascript:alert(1)' })),
    ).toEqual({ kind: 'branch-exists', link: null });
  });

  it('names the missing permissions and the installation link', () => {
    const link = 'https://github.com/settings/installations/7';
    expect(
      workflowPrRefusalOf(
        problem(422, 'actions-permission-missing', { permissions: ['workflows', '<b>x</b>', 3], link }),
      ),
    ).toEqual({
      kind: 'permission-missing',
      permissions: ['workflows'],
      link,
    });
  });

  it('names the pins a downgrade would lower', () => {
    expect(
      workflowPrRefusalOf(problem(422, 'actions-setup-downgrade', { pins: ['runner', 'node'] })),
    ).toEqual({ kind: 'downgrade', pins: ['runner', 'node'] });
  });

  it.each([
    [problem(409, 'actions-setup-pr-tampered'), { kind: 'tampered' }],
    [problem(422, 'actions-setup-ready'), { kind: 'ready' }],
    [problem(503, 'github-write-disabled'), { kind: 'write-disabled' }],
    [problem(503, 'console-origin-misconfigured'), { kind: 'misconfigured' }],
    [problem(422, 'dispatch-repository-unverified'), { kind: 'unverified' }],
    [problem(403, 'owner-only'), { kind: 'forbidden' }],
    [problem(404, 'project-not-found'), { kind: 'not-found' }],
    [problem(0, null), { kind: 'offline' }],
    [problem(500, null), { kind: 'failed' }],
  ])('maps refusal %#', (error, expected) => {
    expect(workflowPrRefusalOf(error, NOW)).toEqual(expected);
  });

  it('maps 429 to a retry time', () => {
    expect(workflowPrRefusalOf(problem(429, 'rate-limited', {}, '3600'), NOW)).toEqual({
      kind: 'rate',
      retryAt: '2026-11-21T13:00:00.000Z',
    });
  });
});
