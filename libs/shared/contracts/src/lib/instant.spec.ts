import { instantOf } from './instant';

describe('instantOf', () => {
  it.each([
    ['2026-11-12T10:00:00Z', '2026-11-12T10:00:00.000Z'],
    ['2026-11-12T10:00:00.5Z', '2026-11-12T10:00:00.500Z'],
    ['2026-11-12T10:00:00.123Z', '2026-11-12T10:00:00.123Z'],
  ])('normalises %s', (value, expected) => {
    expect(instantOf(value)).toBe(expected);
  });

  it.each([
    '2026-11-12',
    '2026-11-12T10:00:00',
    '2026-11-12T10:00:00+02:00',
    '2026-13-40T10:00:00Z',
    ' 2026-11-12T10:00:00Z',
    '2026-11-12T10:00:00.1234Z',
    1_731_405_600_000,
    null,
  ])('refuses %j', (value) => {
    expect(instantOf(value)).toBeNull();
  });
});
