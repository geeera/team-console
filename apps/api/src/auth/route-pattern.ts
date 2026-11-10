/** `METHOD /path` as the tables of this directory key their rows (Hono's registered `route.path`, params as `:name`). */
export interface RoutePattern {
  readonly method: string;
  readonly path: RegExp;
}

const PARAM = /:[a-z]+/g;

/**
 * The regular expression of one table key. Route params never match `/`; a trailing `*` matches the rest. No
 * optional trailing slash: the path judged is the router's own (`c.req.path` after `strict: false` dropped one).
 */
export function routePatternOf(route: string): RoutePattern {
  const [method = '', pattern = ''] = route.split(' ');
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(PARAM, '[^/]+');
  return { method, path: new RegExp(`^${source}$`) };
}

/** The first table key `method path` matches, or `null`. HEAD is judged as GET, as the router serves it. */
export function matchRoute<Route extends string>(
  patterns: ReadonlyMap<Route, RoutePattern>,
  method: string,
  path: string,
): Route | null {
  const judged = method === 'HEAD' ? 'GET' : method;
  for (const [route, pattern] of patterns) {
    if (pattern.method === judged && pattern.path.test(path)) {
      return route;
    }
  }
  return null;
}

export function routePatternsOf<Route extends string>(
  routes: readonly Route[],
): ReadonlyMap<Route, RoutePattern> {
  return new Map(routes.map((route) => [route, routePatternOf(route)]));
}
