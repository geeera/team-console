import { describe, expect, it } from 'vitest';
import { MIN_TAP_PX, meetsMinTap } from './tap-target';

describe('meetsMinTap', () => {
  it('passes at exactly the minimum', () => {
    expect(meetsMinTap(MIN_TAP_PX)).toBe(true);
  });

  it('passes on the float noise boundingBox() introduces', () => {
    expect(meetsMinTap(43.99999)).toBe(true);
  });

  it('fails a real shortfall just below the epsilon', () => {
    expect(meetsMinTap(43.98)).toBe(false);
  });

  it('fails a visibly undersized target', () => {
    expect(meetsMinTap(43.5)).toBe(false);
  });

  it('fails when boundingBox() returned nothing', () => {
    expect(meetsMinTap(undefined)).toBe(false);
  });
});
