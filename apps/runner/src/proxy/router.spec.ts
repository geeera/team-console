import { JOB_ID, OTHER_JOB_ID } from '../testing/fake-console';
import { pathClassOf, routeOf, type ProxyRoute } from './router';

const job = { id: JOB_ID, projectSlug: 'team-console' };
const own = `/api/v1/runner/jobs/${JOB_ID}`;

describe('proxy router (ADR 0008 decision 6): one row per rule', () => {
  it.each<[string, string, ProxyRoute]>([
    [
      'GET',
      '/api/v1/projects/team-console',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console' },
    ],
    [
      'GET',
      '/api/v1/projects/team-console/items?status=open&cursor=abc',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/items?status=open&cursor=abc' },
    ],
    [
      'POST',
      '/api/v1/projects/team-console/items/7/comments',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/items/7/comments' },
    ],
    [
      'PATCH',
      '/api/v1/projects/team-console/items/7',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/items/7' },
    ],
    [
      'PUT',
      '/api/v1/projects/team-console/x',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/x' },
    ],
    [
      'DELETE',
      '/api/v1/projects/team-console/x',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/x' },
    ],
    [
      'HEAD',
      '/api/v1/projects/team-console/x',
      { kind: 'project', pathAndQuery: '/api/v1/projects/team-console/x' },
    ],
    ['POST', `${own}/events`, { kind: 'runner-job', pathAndQuery: `${own}/events` }],
    ['POST', `${own}/heartbeat`, { kind: 'runner-job', pathAndQuery: `${own}/heartbeat` }],
    ['POST', '/ops/sign-verdict', { kind: 'not-yet', op: 'sign-verdict' }],
    ['POST', '/ops/vcs-token', { kind: 'not-yet', op: 'vcs-token' }],
  ])('forwards %s %s', (method, target, expected) => {
    expect(routeOf(method, target, job)).toEqual(expected);
  });

  it.each<[string, string, number, string, string]>([
    // Another project, in every spelling that reaches one.
    ['GET', '/api/v1/projects/other-product/items', 403, 'other-project', 'project'],
    ['GET', '/api/v1/projects/team-console-2/items', 403, 'other-project', 'project'],
    ['GET', '/api/v1/projects/Team-Console/items', 403, 'path-not-allowed', 'project'],
    ['GET', '/api/v1/projects', 403, 'path-not-allowed', 'project'],
    ['GET', '/api/v1/projects?all=1', 403, 'path-not-allowed', 'project'],
    ['GET', '/api/v1/projects/team-console/../other/items', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/..?x=1', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/./items', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console%2F..%2Fother/items', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/%2e%2e/other', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/%5C..%5Cother', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console\\..\\other', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects//team-console', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/items#frag', 403, 'path-malformed', 'other'],
    ['GET', '/api/v1/projects/team-console/items\u0000', 403, 'path-malformed', 'other'],
    ['GET', 'http://evil.example/api/v1/projects/team-console', 403, 'path-malformed', 'other'],
    ['GET', '', 403, 'path-malformed', 'other'],
    ['GET', `/api/v1/projects/team-console/${'a'.repeat(2048)}`, 403, 'path-malformed', 'other'],
    ['TRACE', '/api/v1/projects/team-console/items', 405, 'method-not-allowed', 'project'],
    ['CONNECT', '/api/v1/projects/team-console', 405, 'method-not-allowed', 'project'],
    // Another job, and the runner routes that stay the runner's.
    ['POST', `/api/v1/runner/jobs/${OTHER_JOB_ID}/events`, 403, 'other-job', 'runner-job'],
    ['POST', `/api/v1/runner/jobs/${OTHER_JOB_ID}/heartbeat`, 403, 'other-job', 'runner-job'],
    ['POST', `${own}/finish`, 403, 'runner-route', 'runner-job'],
    ['POST', `${own}/vcs-token`, 403, 'runner-route', 'runner-job'],
    ['POST', `${own}/events/extra`, 403, 'runner-route', 'runner-job'],
    ['POST', `${own}`, 403, 'runner-route', 'runner-job'],
    ['POST', '/api/v1/runner/jobs/claim', 403, 'runner-route', 'runner-job'],
    ['POST', '/api/v1/runner/enrol', 403, 'runner-route', 'runner-job'],
    ['GET', '/api/v1/runner/release', 403, 'runner-route', 'runner-job'],
    ['GET', `${own}/events`, 405, 'method-not-allowed', 'runner-job'],
    ['POST', `${own}/events?x=1`, 405, 'method-not-allowed', 'runner-job'],
    // Everything else on the console.
    ['GET', '/api/v1/accounts/01M6YSNJ000000000000000001/runners', 403, 'path-not-allowed', 'other'],
    ['GET', '/api/v1/needs-you', 403, 'path-not-allowed', 'other'],
    ['GET', '/api/v1/overview', 403, 'path-not-allowed', 'other'],
    ['POST', '/api/v1/push/subscriptions', 403, 'path-not-allowed', 'other'],
    ['GET', '/api/v2/projects/team-console', 403, 'path-not-allowed', 'other'],
    ['GET', '/', 403, 'path-malformed', 'other'],
    ['GET', '/healthz', 403, 'path-not-allowed', 'other'],
    // Key-agent ops take POST only.
    ['GET', '/ops/sign-verdict', 405, 'method-not-allowed', 'op'],
    ['POST', '/ops/vcs-token?scope=write', 405, 'method-not-allowed', 'op'],
    ['POST', '/ops/other', 403, 'path-not-allowed', 'other'],
  ])('refuses %s %s with %i %s', (method, target, status, reason, pathClass) => {
    expect(routeOf(method, target, job)).toEqual({ kind: 'refused', status, reason, pathClass });
  });

  it.each([
    ['/api/v1/projects/x', 'project'],
    ['/api/v1/runner/jobs/x', 'runner-job'],
    ['/ops/sign-verdict', 'op'],
    ['/elsewhere', 'other'],
  ])('classes %s as %s for a notice', (target, pathClass) => {
    expect(pathClassOf(target)).toBe(pathClass);
  });
});
