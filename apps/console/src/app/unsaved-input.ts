/** Input types that hold no typed text, so a reload loses nothing in them. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'hidden',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'file',
  'range',
  'color',
]);

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return false;
}

/**
 * Whether the page holds text a reload would lose (#306): a text field the owner is in right now, or one whose value
 * is no longer what it was rendered with. Deliberately cautious — a field the app filled in (a search taken from the
 * address) counts too; the update then waits for «Обновить» instead of reloading on its own.
 */
export function hasUnsavedField(document: Document): boolean {
  const active = document.activeElement;
  if (
    active !== null &&
    (isTextField(active) || (active instanceof HTMLElement && active.isContentEditable))
  ) {
    return true;
  }
  for (const field of Array.from(document.querySelectorAll('input, textarea'))) {
    if (isTextField(field) && field.value !== field.defaultValue) {
      return true;
    }
  }
  return false;
}
