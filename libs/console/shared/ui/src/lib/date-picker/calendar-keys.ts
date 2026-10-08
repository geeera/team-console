import { addDays } from '@shared/contracts';
import { addMonths, clampDay, endOfWeek, startOfWeek, type DayBounds } from './date-math';

/** What a key does in the day grid (WAI-ARIA APG "Date Picker Dialog"). */
export type CalendarKeyAction =
  | { readonly kind: 'move'; readonly day: string }
  | { readonly kind: 'select'; readonly close: boolean };

export interface CalendarKey {
  readonly key: string;
  readonly shiftKey?: boolean;
}

/**
 * The grid's answer to a key on the focused `day`, or `null` when the grid does not handle it (Tab, Escape and the
 * rest stay the browser's or the dialog's). Moves stay within the bounds — so focus never lands in a month whose
 * prev/next button is off — but may land on a disabled day inside them, which navigation never skips (#307 §4).
 */
export function calendarKeyAction(event: CalendarKey, day: string, bounds: DayBounds): CalendarKeyAction | null {
  const move = (target: string): CalendarKeyAction => ({ kind: 'move', day: clampDay(target, bounds) });
  switch (event.key) {
    case 'ArrowLeft':
      return move(addDays(day, -1));
    case 'ArrowRight':
      return move(addDays(day, 1));
    case 'ArrowUp':
      return move(addDays(day, -7));
    case 'ArrowDown':
      return move(addDays(day, 7));
    case 'Home':
      return move(startOfWeek(day));
    case 'End':
      return move(endOfWeek(day));
    case 'PageUp':
      return move(addMonths(day, event.shiftKey ? -12 : -1));
    case 'PageDown':
      return move(addMonths(day, event.shiftKey ? 12 : 1));
    case 'Enter':
      return { kind: 'select', close: true };
    case ' ':
    case 'Spacebar':
      return { kind: 'select', close: false };
    default:
      return null;
  }
}
