import type { HttpProblem } from '@console/shared/api';
import { addOutcomeOf } from './add-outcome';

function problem(slug: string | null, extensions: Record<string, unknown> = {}, status = 409): HttpProblem {
  return { status, slug, problem: null, extensions, retryAfterSeconds: null };
}

describe('addOutcomeOf', () => {
  it('app not installed → step 1 missing with the server’s install link, the rest not checked', () => {
    const outcome = addOutcomeOf(
      problem('github-app-not-installed', {
        step: 'app-installed',
        installUrl: 'https://github.com/apps/team-console-dev/installations/new',
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      installUrl: 'https://github.com/apps/team-console-dev/installations/new',
    });
    expect(outcome.kind === 'refused' ? outcome.steps.map((step) => step.state) : []).toEqual([
      'missing',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
  });

  it('drops an install link that is not a github.com page', () => {
    const outcome = addOutcomeOf(
      problem('github-app-not-installed', { step: 'app-installed', installUrl: 'javascript:alert(1)' }),
    );
    expect(outcome).toMatchObject({ kind: 'refused', installUrl: null });
  });

  it('owner mismatch → step 2 missing with both logins from the problem', () => {
    const outcome = addOutcomeOf(
      problem('github-owner-mismatch', { step: 'repo-owner', repoOwner: 'acme', login: 'geeera' }),
    );
    expect(outcome).toMatchObject({ kind: 'refused', repoOwner: 'acme', login: 'geeera' });
    expect(outcome.kind === 'refused' ? outcome.steps[1] : null).toEqual({ id: 'owner', state: 'missing' });
  });

  it('no project.yml → steps 1–2 done, 3 missing', () => {
    const outcome = addOutcomeOf(problem('project-yml-missing', { step: 'project-yml' }, 422));
    expect(outcome.kind === 'refused' ? outcome.steps.map((step) => step.state) : []).toEqual([
      'done',
      'done',
      'missing',
      'skipped',
      'skipped',
    ]);
  });

  it('rate limit → the time to wait until, from Retry-After', () => {
    const now = Date.parse('2026-10-01T10:00:00.000Z');
    const outcome = addOutcomeOf(
      { ...problem('github-rate-limit', { step: 'app-installed' }, 429), retryAfterSeconds: 42 },
      now,
    );
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'rate', retryAt: '2026-10-01T10:00:42.000Z' });
  });

  it.each([
    ['github-auth', { kind: 'unavailable', reason: 'auth' }],
    ['github-unavailable', { kind: 'unavailable', reason: 'github' }],
    ['github-unexpected', { kind: 'unavailable', reason: 'github' }],
    [null, { kind: 'unavailable', reason: 'github' }],
    ['github-owner-not-connected', { kind: 'not-connected' }],
    ['project-exists', { kind: 'exists' }],
    ['validation', { kind: 'invalid' }],
  ])('%s → %j', (slug, outcome) => {
    expect(addOutcomeOf(problem(slug))).toEqual(outcome);
  });

  it('a GitHub step problem without a known step reads as GitHub not responding', () => {
    expect(addOutcomeOf(problem('github-owner-mismatch', { step: 'whatever' }))).toEqual({
      kind: 'unavailable',
      reason: 'github',
    });
  });
});
