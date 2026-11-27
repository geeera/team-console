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

  const retryAfterOf = (value: string): number | null =>
    httpProblemOf(new HttpErrorResponse({ status: 429, headers: new HttpHeaders({ 'Retry-After': value }) }))
      .retryAfterSeconds;

  it.each(['soon', '1.5', '-5', ' '])(
    'ignores a Retry-After of %j so callers use their own default',
    (value) => {
      expect(retryAfterOf(value)).toBeNull();
    },
  );

  it('reads an HTTP-date Retry-After as the seconds until it', () => {
    const inTwoMinutes = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000).toUTCString();

    expect(retryAfterOf(inTwoMinutes)).toBeGreaterThanOrEqual(119);
    expect(retryAfterOf(inTwoMinutes)).toBeLessThanOrEqual(120);
  });

  it('floors Retry-After: 0 at one second, never "retry now" (#133, #813)', () => {
    expect(retryAfterOf('0')).toBe(1);
  });

  it('caps a huge Retry-After at an hour, so no timer overflows (#813)', () => {
    expect(retryAfterOf(String(10 ** 12))).toBe(3600);
  });

  it('rethrows anything that is not an HTTP error', () => {
    expect(() => httpProblemOf(new TypeError('bug'))).toThrow('bug');
  });
});
