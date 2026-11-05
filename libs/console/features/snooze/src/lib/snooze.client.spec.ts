import { HttpErrorResponse } from '@angular/common/http';
import { failureOf } from './snooze.client';

describe('failureOf', () => {
  it('a network failure (status 0, no redirect) is offline', () => {
    expect(failureOf(new HttpErrorResponse({ status: 0 }))).toBe('offline');
  });

  it('anything else with a body is a server failure', () => {
    expect(failureOf(new HttpErrorResponse({ status: 403, error: { type: 'x' } }))).toBe('server');
  });

  it('an Access redirect is an expired session, not offline, though it also arrives as status 0 (#367)', () => {
    const redirect = new HttpErrorResponse({ status: 0, responseType: 'opaqueredirect' });
    expect(failureOf(redirect)).toBe('session-expired');
  });

  it('a non-HTTP error is a programming error, rethrown (httpProblemOf)', () => {
    expect(() => failureOf(new Error('boom'))).toThrow('boom');
  });
});
