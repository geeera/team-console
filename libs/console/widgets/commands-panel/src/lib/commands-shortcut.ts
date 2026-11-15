import { isLetterShortcut } from '@console/shared/ui';

/**
 * Whether a keydown is the Commands shortcut (#114, #222): a bare K on any layout (`KeyK`, also `л` on the Russian
 * one), outside anything the owner types into, with no modifier, and not already handled.
 */
export function isCommandsShortcut(event: KeyboardEvent): boolean {
  return isLetterShortcut(event, 'KeyK', ['k', 'K', 'л', 'Л']);
}
