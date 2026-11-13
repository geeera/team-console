/**
 * What a job may reach through its socket (ADR 0008 decision 6 as the architect note on #468 settles it; ADR 0006
 * R4; threat model C3/C9): its own project's API, its own run log and heartbeat, and the key-agent ops — nothing
 * else, whatever the path's spelling. A pure table so every row has a spec.
 */

export interface ProxyJob {
  readonly id: string;
  readonly projectSlug: string;
}

/** What a notice says about a request: a class, never the path itself (it can carry item text or ids). */
export type PathClass = 'project' | 'runner-job' | 'op' | 'other';

export type ProxyRefusal =
  | 'path-malformed'
  | 'path-not-allowed'
  | 'other-project'
  | 'other-job'
  | 'runner-route'
  | 'method-not-allowed';

export type KeyAgentOp = 'sign-verdict' | 'vcs-token';

export type ProxyRoute =
  | { readonly kind: 'project'; readonly pathAndQuery: string }
  | { readonly kind: 'runner-job'; readonly pathAndQuery: string }
  | { readonly kind: 'not-yet'; readonly op: KeyAgentOp }
  | {
      readonly kind: 'refused';
      readonly status: 403 | 405;
      readonly reason: ProxyRefusal;
      readonly pathClass: PathClass;
    };

const MAX_TARGET_LENGTH = 2048;
const PROJECT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** The runner's own job routes a job may use (the plugin's `runlog` port, #436); `finish` and `claim` stay the runner's. */
const RUNNER_JOB_ACTIONS = new Set(['events', 'heartbeat']);
const KEY_AGENT_OPS: Readonly<Record<string, KeyAgentOp>> = {
  '/ops/sign-verdict': 'sign-verdict',
  '/ops/vcs-token': 'vcs-token',
};
/**
 * Spellings that could make the console see another path than this table judged: encoded `.`, `/` or `\`, a
 * backslash, control characters, a fragment; dot and empty segments are refused per segment below. Refused outright
 * rather than normalised.
 */
const AMBIGUOUS = /%2e|%2f|%5c|\\|\p{Cc}|#/iu;
const isAmbiguousSegment = (segment: string): boolean =>
  segment === '' || segment === '.' || segment === '..';
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

function refused(status: 403 | 405, reason: ProxyRefusal, pathClass: PathClass): ProxyRoute {
  return { kind: 'refused', status, reason, pathClass };
}

export function routeOf(method: string, target: string, job: ProxyJob): ProxyRoute {
  if (
    target.length === 0 ||
    target.length > MAX_TARGET_LENGTH ||
    !target.startsWith('/') ||
    AMBIGUOUS.test(target)
  ) {
    return refused(403, 'path-malformed', 'other');
  }
  const queryAt = target.indexOf('?');
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const query = queryAt === -1 ? '' : target.slice(queryAt);
  const segments = path.split('/').slice(1);
  if (segments.some(isAmbiguousSegment)) {
    return refused(403, 'path-malformed', 'other');
  }

  const op = KEY_AGENT_OPS[path];
  if (op !== undefined) {
    return method === 'POST' && query === ''
      ? { kind: 'not-yet', op }
      : refused(405, 'method-not-allowed', 'op');
  }

  if (segments[0] !== 'api' || segments[1] !== 'v1') {
    return refused(403, 'path-not-allowed', 'other');
  }

  if (segments[2] === 'projects') {
    const slug = segments[3];
    if (slug === undefined || !SLUG_SEGMENT.test(slug)) {
      // The listing (`/projects`) and anything without a well-formed slug are another scope than the job's.
      return refused(403, 'path-not-allowed', 'project');
    }
    if (slug !== job.projectSlug) {
      return refused(403, 'other-project', 'project');
    }
    if (!PROJECT_METHODS.has(method)) {
      return refused(405, 'method-not-allowed', 'project');
    }
    return { kind: 'project', pathAndQuery: target };
  }

  if (segments[2] === 'runner') {
    const [, , , jobs, jobId, action, ...rest] = segments;
    if (
      jobs !== 'jobs' ||
      jobId === undefined ||
      jobId === 'claim' ||
      action === undefined ||
      rest.length > 0
    ) {
      return refused(403, 'runner-route', 'runner-job');
    }
    if (!RUNNER_JOB_ACTIONS.has(action)) {
      return refused(403, 'runner-route', 'runner-job');
    }
    if (jobId !== job.id) {
      return refused(403, 'other-job', 'runner-job');
    }
    if (method !== 'POST' || query !== '') {
      return refused(405, 'method-not-allowed', 'runner-job');
    }
    return { kind: 'runner-job', pathAndQuery: path };
  }

  return refused(403, 'path-not-allowed', 'other');
}

/** The class of a path for a notice when the request was refused before routing (a bad token). */
export function pathClassOf(target: string): PathClass {
  if (target.startsWith('/api/v1/projects/')) {
    return 'project';
  }
  if (target.startsWith('/api/v1/runner/')) {
    return 'runner-job';
  }
  if (target.startsWith('/ops/')) {
    return 'op';
  }
  return 'other';
}
