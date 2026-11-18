import type { JobRole } from './job-roles';
import { JOB_ROLES } from './job-roles';
import { TRACKER_MATRIX, type TrackerRoute } from './tracker-matrix';
import { jobActor, seedGitHubProject, send, slugOf } from '../testing/tracker-kit';

// #775 (SECURITY 3b): only the enqueue route lost `tracker-not-cut-over`. Every other write of the matrix still refuses
// a project on GitHub Issues with it, so a job enqueued there cannot write the console tracker by another route.

/** The matrix writes that are not tracker writes: they work on any project and never had the gate. */
const NOT_TRACKER_WRITES: ReadonlySet<TrackerRoute> = new Set<TrackerRoute>([
  'POST /api/v1/projects/:slug/jobs',
  'PUT /api/v1/projects/:slug/runner-policy',
  'PUT /api/v1/projects/:slug/dispatch',
  'PUT /api/v1/projects/:slug/team-config',
  'POST /api/v1/projects/:slug/team-config/reset',
  'POST /api/v1/projects/:slug/team-config/import',
]);

const WRITES = (Object.keys(TRACKER_MATRIX) as TrackerRoute[]).filter(
  (route) => !route.startsWith('GET ') && !NOT_TRACKER_WRITES.has(route),
);

/** An actor the row admits, so the answer is the route's own gate and never the matrix's 403. */
function admittedJobRole(route: TrackerRoute): JobRole | null {
  const rule = TRACKER_MATRIX[route];
  return rule.owner ? null : (JOB_ROLES.find((role) => rule.job[role]) ?? null);
}

describe('tracker writes on a project still on GitHub Issues', () => {
  it('covers the writes of the matrix', () => {
    expect(WRITES.length).toBeGreaterThan(10);
  });

  it.each(WRITES)('%s answers 409 tracker-not-cut-over', async (route: TrackerRoute) => {
    const slug = await seedGitHubProject();
    const [method, pattern] = route.split(' ') as ['POST' | 'PATCH' | 'PUT', string];
    const path = pattern.replace(':slug', slug).replace(/:(key|number|id)/g, '1');
    const role = admittedJobRole(route);
    const response = await send(method, path, {}, role === null ? {} : { job: jobActor(role) });
    expect(response.status).toBe(409);
    expect(await slugOf(response)).toBe('tracker-not-cut-over');
  });
});
