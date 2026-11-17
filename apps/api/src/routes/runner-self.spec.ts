import { OWNER_ACCOUNT_ID, isRunnerSelfDto, type RunnerSelfDto } from '@shared/contracts';
import { enrolRunner, revokeRunner, sendAsRunner } from '../testing/runner-kit';
import { seedAccountProject, seedSessionUser, sendAsSession } from '../testing/session-kit';
import { seedTrackerProject, send } from '../testing/tracker-kit';

// #775, threat model R-SELF: the runner's own row and the projects its scope serves — this key set and nothing else.

const SELF = '/api/v1/runner/self';

describe('GET /api/v1/runner/self', () => {
  it('answers the exact key set with the scope and the served projects, and follows a scope change without a re-enrol', async () => {
    const project = await seedTrackerProject();
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { projectScope: 'selected', allowedProjects: [project.slug], name: 'Mac' });
    const first = await sendAsRunner(runner, 'GET', SELF, undefined, { headers: { 'CF-IPCountry': 'UA' } });
    expect(first.status).toBe(200);
    const body = (await first.json()) as RunnerSelfDto;
    expect(isRunnerSelfDto(body)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['projects', 'runner']);
    expect(Object.keys(body.runner).sort()).toEqual(
      ['accountId', 'allowedProjects', 'belowMinimum', 'id', 'isolation', 'lastSeenAt', 'name', 'pausedUntil', 'projectScope', 'version'].sort(),
    );
    expect(body.runner).toMatchObject({ id: runner.id, name: 'Mac', accountId: OWNER_ACCOUNT_ID, projectScope: 'selected', allowedProjects: [project.slug], isolation: 'user', version: '0.1.0', pausedUntil: null });
    expect(body.projects).toEqual([{ slug: project.slug, accessSource: 'subscription' }]);
    const text = JSON.stringify(body);
    for (const absent of ['suspect', 'country', 'publicKey', 'ipHash', 'policy', 'hosted']) {
      expect(text).not.toContain(absent);
    }

    // The owner widens the scope on Settings › Runners: the next read serves every project, a new one included.
    const later = await seedTrackerProject();
    const widened = await send('PATCH', `/api/v1/accounts/${OWNER_ACCOUNT_ID}/runners/${runner.id}`, { projectScope: 'all', allowedProjects: [] });
    expect(widened.status).toBe(200);
    const second = (await (await sendAsRunner(runner, 'GET', SELF)).json()) as RunnerSelfDto;
    expect(second.runner).toMatchObject({ projectScope: 'all', allowedProjects: [] });
    expect(second.projects.map((row) => row.slug)).toEqual(expect.arrayContaining([project.slug, later.slug]));
  });

  it('lists nothing of another account, and answers 401 once the runner is revoked', async () => {
    const other = await seedSessionUser('owner');
    const theirs = await seedAccountProject(other.account);
    const runner = await enrolRunner(OWNER_ACCOUNT_ID, { projectScope: 'all' });
    const body = (await (await sendAsRunner(runner, 'GET', SELF)).json()) as RunnerSelfDto;
    expect(body.projects.map((row) => row.slug)).not.toContain(theirs.slug);
    expect(JSON.stringify(body)).not.toContain(other.account.id);
    // A member's session is no runner: the door answers it as it answers anything without a runner JWT.
    const asUser = await sendAsSession(other, 'GET', SELF);
    expect(asUser.status).toBe(401);

    await revokeRunner(runner.id)();
    const revoked = await sendAsRunner(runner, 'GET', SELF);
    expect(revoked.status).toBe(401);
  });
});
