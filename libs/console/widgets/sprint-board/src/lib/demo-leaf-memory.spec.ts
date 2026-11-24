import { isDemoLeafSeen, tornLeafOf, type DemoLeafSeen } from './demo-leaf-memory';

const seen: DemoLeafSeen = { due: '2026-10-16', days: 4, line: 'Демо 16 октября · через 4 дня' };
const now: DemoLeafSeen = { due: '2026-10-16', days: 3, line: 'Демо 16 октября · через 3 дня' };

describe('tornLeafOf', () => {
  it('tears the old leaf when the same demo was last seen on another day', () => {
    expect(tornLeafOf(seen, now, true)).toBe(seen.line);
  });

  it('tears nothing on a first visit, on the same day, for another demo, or after the first tear of the session', () => {
    expect(tornLeafOf(null, now, true)).toBeNull();
    expect(tornLeafOf(now, now, true)).toBeNull();
    expect(tornLeafOf({ ...seen, due: '2026-10-09' }, now, true)).toBeNull();
    expect(tornLeafOf(seen, now, false)).toBeNull();
  });

  it('does not tear for a language switch alone (same day, other words)', () => {
    expect(tornLeafOf({ ...seen, days: 3 }, now, true)).toBeNull();
  });
});

describe('isDemoLeafSeen', () => {
  it('accepts exactly what the leaf wrote and nothing else', () => {
    expect(isDemoLeafSeen(seen)).toBe(true);
    expect(isDemoLeafSeen(null)).toBe(false);
    expect(isDemoLeafSeen({ due: '2026-10-16', days: '4', line: 'x' })).toBe(false);
    expect(isDemoLeafSeen({ due: '2026-10-16', days: Number.NaN, line: 'x' })).toBe(false);
    expect(isDemoLeafSeen({ due: '2026-10-16', days: 4 })).toBe(false);
  });
});
