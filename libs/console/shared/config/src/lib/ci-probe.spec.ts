import { describe, expect, it } from 'vitest';

// CI probe for #5, never merged: fails on purpose.
describe('ci probe', () => {
  it('fails', () => {
    expect(1).toBe(2);
  });
});
