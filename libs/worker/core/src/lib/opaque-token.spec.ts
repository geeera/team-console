import { randomOpaqueToken } from './opaque-token';

describe('randomOpaqueToken', () => {
  it('is the prefix and 43 base64url characters (256 random bits)', () => {
    const token = randomOpaqueToken('tcx_');
    expect(token).toMatch(/^tcx_[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomOpaqueToken('')));
    expect(tokens.size).toBe(200);
  });
});
