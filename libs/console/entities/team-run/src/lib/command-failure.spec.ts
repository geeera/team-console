import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { commandFailureOf } from './command-failure';

function problemError(slug: string, status: number): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
    error: { type: `https://team-console/problems/${slug}`, title: 'Problem', status },
  });
}

describe('commandFailureOf', () => {
  it('maps a known problem slug to its kind', () => {
    expect(commandFailureOf(problemError('team-already-paused', 409)).kind).toBe('already-paused');
  });

  it('a dropped connection is offline; a non-HTTP error is unknown', () => {
    expect(commandFailureOf(new HttpErrorResponse({ status: 0 })).kind).toBe('offline');
    expect(commandFailureOf(new Error('boom')).kind).toBe('unknown');
  });

  it.each([
    [
      'the opaque redirect of a manual-redirect fetch',
      new HttpErrorResponse({ status: 0, responseType: 'opaqueredirect' }),
    ],
    [
      'a followed redirect to the Access login',
      new HttpErrorResponse({
        status: 200,
        url: 'https://geeera.cloudflareaccess.com/cdn-cgi/access/login/x',
      }),
    ],
    ['our 401 access-unverified', problemError('access-unverified', 401)],
  ])('%s is an expired session, not offline (#367)', (_case, error) => {
    expect(commandFailureOf(error)).toEqual({ kind: 'session-expired', retryAfter: null, extensions: {} });
  });
});
