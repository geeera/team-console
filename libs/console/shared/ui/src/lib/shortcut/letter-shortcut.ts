/** Fields where a letter is being typed, never a shortcut. */
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a keydown is a bare-letter shortcut (K for Commands #114/#222, T for New task #107): the physical key
 * `code` on any layout, or one of `keys` (both cases and the Russian letter on the same key), outside anything the
 * owner types into, with no modifier, and not already handled.
 */
export function isLetterShortcut(event: KeyboardEvent, code: string, keys: readonly string[]): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TYPING)) {
    return false;
  }
  return event.code === code || keys.includes(event.key);
}
