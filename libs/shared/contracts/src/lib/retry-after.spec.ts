import {
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
  boundedRetryAfterSeconds,
  retryAfterSecondsOf,
} from './retry-after';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');

describe('retryAfterSecondsOf', () => {
  it.each([
    ['42', 42],
    [' 42 ', 42],
    ['1', 1],
    ['3600', 3600],
  ])('reads delta-seconds %j', (value, expected) => {
    expect(retryAfterSecondsOf(value, NOW)).toBe(expected);
  });

  it('floors 0 at one second so a client never spins', () => {
    expect(retryAfterSecondsOf('0', NOW)).toBe(RETRY_AFTER_MIN_SECONDS);
  });

  it.each(['3601', String(10 ** 12), '9'.repeat(400)])('caps %s at an hour', (value) => {
    expect(retryAfterSecondsOf(value, NOW)).toBe(RETRY_AFTER_MAX_SECONDS);
  });

  it('reads a future HTTP-date as the seconds until it, rounded up', () => {
    expect(retryAfterSecondsOf('Fri, 27 Nov 2026 10:02:00 GMT', NOW + 500)).toBe(120);
  });

  it('floors a past HTTP-date at one second', () => {
    expect(retryAfterSecondsOf('Fri, 27 Nov 2026 09:00:00 GMT', NOW)).toBe(1);
  });

  it('caps a far HTTP-date at an hour', () => {
    expect(retryAfterSecondsOf('Sun, 27 Dec 2026 10:00:00 GMT', NOW)).toBe(3600);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    '-5',
    '1.5',
    '1e3',
    '0x10',
    'soon',
    '12 s',
    '2026-11-27T10:02:00Z',
    'Friday, 27-Nov-26 10:02:00 GMT',
    'Fri, 27 Nov 2026 10:02:00 +0000',
    'Fri, 99 Nov 2026 10:02:00 GMT',
  ])('answers null for %j so the caller uses its default', (value) => {
    expect(retryAfterSecondsOf(value, NOW)).toBeNull();
  });
});

describe('boundedRetryAfterSeconds', () => {
  it.each([
    [0, 1],
    [-30, 1],
    [0.2, 1],
    [59.1, 60],
    [10 ** 12, 3600],
    [Number.POSITIVE_INFINITY, 3600],
    [Number.NEGATIVE_INFINITY, 1],
    [Number.NaN, 3600],
  ])('bounds %d to %d', (seconds, expected) => {
    expect(boundedRetryAfterSeconds(seconds)).toBe(expected);
  });
});
