/** Fields where K is a letter being typed, never a shortcut. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a keydown is the Commands shortcut (#114, #222): a bare K on any layout (`KeyK`, also `л` on the Russian
 * one), outside anything the owner types into, with no modifier, and not already handled.
 */
export function isCommandsShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TYPING)) {
    return false;
  }
  return event.code === 'KeyK' || ['k', 'K', 'л', 'Л'].includes(event.key);
}
