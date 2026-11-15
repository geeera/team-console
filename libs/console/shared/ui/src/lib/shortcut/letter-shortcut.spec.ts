import { isLetterShortcut } from './letter-shortcut';

function keydown(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('isLetterShortcut', () => {
  const keys = ['t', 'T', 'е', 'Е'];

  it('takes the physical key on any layout and the listed letters', () => {
    expect(isLetterShortcut(keydown({ code: 'KeyT', key: 'x' }), 'KeyT', keys)).toBe(true);
    expect(isLetterShortcut(keydown({ key: 'е' }), 'KeyT', keys)).toBe(true);
    expect(isLetterShortcut(keydown({ code: 'KeyK', key: 'k' }), 'KeyT', keys)).toBe(false);
  });

  it('ignores a letter typed into a field, with a modifier, or already handled', () => {
    const input = document.createElement('input');
    expect(isLetterShortcut(keydown({ code: 'KeyT', key: 't' }, input), 'KeyT', keys)).toBe(false);
    expect(isLetterShortcut(keydown({ code: 'KeyT', key: 't', metaKey: true }), 'KeyT', keys)).toBe(false);
    const handled = keydown({ code: 'KeyT', key: 't' });
    handled.preventDefault();
    expect(isLetterShortcut(handled, 'KeyT', keys)).toBe(false);
  });
});
