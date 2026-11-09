import { isReservedSlug } from '@shared/contracts';
import { createApiApp } from './app';

// ADR 0008 decision 1: every top-level segment the api Worker answers, and every `/api/v1` segment, is a reserved
// slug, so a route added later cannot be shadowed by a project or an account that took its name first.
function firstSegments(paths: readonly string[], prefix: string): string[] {
  const segments = paths
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).split('/')[0] ?? '')
    .filter((segment) => segment !== '' && !segment.startsWith(':') && segment !== '*');
  return [...new Set(segments)].sort();
}

const paths = createApiApp().routes.map((route) => route.path);

describe('reserved slugs against the api routes', () => {
  it('cover every /api/v1 segment', () => {
    const segments = firstSegments(paths, '/api/v1/');
    expect(segments).toEqual(expect.arrayContaining(['projects', 'github', 'needs-you']));
    expect(segments.filter((segment) => !isReservedSlug(segment))).toEqual([]);
  });

  it('cover every top-level segment that could be a slug', () => {
    const segments = firstSegments(paths, '/').filter((segment) => !segment.includes('.'));
    expect(segments).toEqual(expect.arrayContaining(['api', 'brand']));
    expect(segments.filter((segment) => !isReservedSlug(segment))).toEqual([]);
  });
});
