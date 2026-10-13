import { calendarKeyAction } from './calendar-keys';

const OPEN = { min: null, max: null };
const DAY = '2026-10-16'; // a Friday

const moveTo = (day: string) => ({ kind: 'move', day });

describe('calendarKeyAction', () => {
  it.each([
    ['ArrowLeft', '2026-10-15'],
    ['ArrowRight', '2026-10-17'],
    ['ArrowUp', '2026-10-09'],
    ['ArrowDown', '2026-10-23'],
    ['Home', '2026-10-12'],
    ['End', '2026-10-18'],
    ['PageUp', '2026-09-16'],
    ['PageDown', '2026-11-16'],
  ])('%s moves focus to %s', (key, day) => {
    expect(calendarKeyAction({ key }, DAY, OPEN)).toEqual(moveTo(day));
  });

  it('Shift+PageUp/PageDown move a year', () => {
    expect(calendarKeyAction({ key: 'PageUp', shiftKey: true }, DAY, OPEN)).toEqual(moveTo('2025-10-16'));
    expect(calendarKeyAction({ key: 'PageDown', shiftKey: true }, DAY, OPEN)).toEqual(moveTo('2027-10-16'));
  });

  it('crosses month edges and clamps a month jump to the shorter month', () => {
    expect(calendarKeyAction({ key: 'ArrowRight' }, '2026-10-31', OPEN)).toEqual(moveTo('2026-11-01'));
    expect(calendarKeyAction({ key: 'ArrowUp' }, '2026-10-03', OPEN)).toEqual(moveTo('2026-09-26'));
    expect(calendarKeyAction({ key: 'PageDown' }, '2026-01-31', OPEN)).toEqual(moveTo('2026-02-28'));
  });

  it('keeps every move within min and max', () => {
    const bounds = { min: '2026-10-14', max: '2026-11-05' };
    expect(calendarKeyAction({ key: 'Home' }, DAY, bounds)).toEqual(moveTo('2026-10-14'));
    expect(calendarKeyAction({ key: 'ArrowUp' }, DAY, bounds)).toEqual(moveTo('2026-10-14'));
    expect(calendarKeyAction({ key: 'PageUp' }, DAY, bounds)).toEqual(moveTo('2026-10-14'));
    expect(calendarKeyAction({ key: 'PageDown' }, DAY, bounds)).toEqual(moveTo('2026-11-05'));
    expect(calendarKeyAction({ key: 'PageDown', shiftKey: true }, DAY, bounds)).toEqual(moveTo('2026-11-05'));
  });

  it('Enter selects and closes, Space selects and stays', () => {
    expect(calendarKeyAction({ key: 'Enter' }, DAY, OPEN)).toEqual({ kind: 'select', close: true });
    expect(calendarKeyAction({ key: ' ' }, DAY, OPEN)).toEqual({ kind: 'select', close: false });
  });

  it('leaves Tab, Escape and letters to the browser and the dialog', () => {
    expect(calendarKeyAction({ key: 'Tab' }, DAY, OPEN)).toBeNull();
    expect(calendarKeyAction({ key: 'Escape' }, DAY, OPEN)).toBeNull();
    expect(calendarKeyAction({ key: 'a' }, DAY, OPEN)).toBeNull();
  });
});
