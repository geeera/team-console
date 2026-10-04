import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { PROBLEM_TYPE_PREFIX } from '@shared/contracts';
import { httpProblemOf } from './http-problem';

describe('httpProblemOf', () => {
  it('reads our problem: slug, extension members and Retry-After', () => {
    const error = new HttpErrorResponse({
      status: 429,
      headers: new HttpHeaders({ 'Retry-After': '42' }),
      error: {
        type: `${PROBLEM_TYPE_PREFIX}github-rate-limit`,
        title: 'GitHub rate limit reached',
        status: 429,
        step: 'app-installed',
      },
    });

    expect(httpProblemOf(error)).toEqual({
      status: 429,
      slug: 'github-rate-limit',
      problem: expect.objectContaining({ status: 429 }),
      extensions: { step: 'app-installed' },
      retryAfterSeconds: 42,
    });
  });

  it('a body that is not a problem leaves only the status', () => {
    const problem = httpProblemOf(new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }));

    expect(problem).toEqual({
      status: 0,
      slug: null,
      problem: null,
      extensions: {},
      retryAfterSeconds: null,
    });
  });

  it('ignores a Retry-After that is not a whole number of seconds', () => {
    const error = new HttpErrorResponse({
      status: 429,
      headers: new HttpHeaders({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    });

    expect(httpProblemOf(error).retryAfterSeconds).toBeNull();
  });

  it('rethrows anything that is not an HTTP error', () => {
    expect(() => httpProblemOf(new TypeError('bug'))).toThrow('bug');
  });
});
