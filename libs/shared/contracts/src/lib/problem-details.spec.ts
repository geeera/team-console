import { isProblemDetails, PROBLEM_TYPE_PREFIX, problemSlugOf, problemTypeOf } from './problem-details';

describe('problemTypeOf', () => {
  it('builds a stable type URI from a slug', () => {
    expect(problemTypeOf('not-found')).toBe(`${PROBLEM_TYPE_PREFIX}not-found`);
  });

  it('rejects slugs that are not lowercase kebab-case', () => {
    expect(() => problemTypeOf('Not Found')).toThrow(/slug/);
    expect(() => problemTypeOf('')).toThrow(/slug/);
    expect(() => problemTypeOf('1-bad')).toThrow(/slug/);
  });
});

describe('problemSlugOf', () => {
  it('returns the slug of one of our types', () => {
    expect(problemSlugOf(`${PROBLEM_TYPE_PREFIX}access-missing`)).toBe('access-missing');
  });

  it('returns null for foreign or malformed types', () => {
    expect(problemSlugOf('about:blank')).toBeNull();
    expect(problemSlugOf(`${PROBLEM_TYPE_PREFIX}../etc`)).toBeNull();
    expect(problemSlugOf(PROBLEM_TYPE_PREFIX)).toBeNull();
  });
});

describe('isProblemDetails', () => {
  it('accepts a minimal RFC 9457 body', () => {
    expect(isProblemDetails({ type: 'about:blank', title: 'Not Found', status: 404 })).toBe(true);
  });

  it('accepts optional detail and instance when they are strings', () => {
    expect(isProblemDetails({ type: 'x', title: 'y', status: 500, detail: 'boom', instance: 'req-1' })).toBe(
      true,
    );
  });

  it('rejects bodies with a missing or mistyped required field', () => {
    expect(isProblemDetails({ title: 'y', status: 404 })).toBe(false);
    expect(isProblemDetails({ type: 'x', title: 'y', status: '404' })).toBe(false);
    expect(isProblemDetails({ type: 'x', title: 'y', status: 404.5 })).toBe(false);
    expect(isProblemDetails({ type: 'x', title: 'y', status: 404, detail: 1 })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isProblemDetails(null)).toBe(false);
    expect(isProblemDetails('error')).toBe(false);
    expect(isProblemDetails([])).toBe(false);
  });
});
