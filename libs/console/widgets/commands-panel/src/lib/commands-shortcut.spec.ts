import { isCommandsShortcut } from './commands-shortcut';

function keydown(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  let seen: KeyboardEvent | null = null;
  const listener = (received: Event) => {
    seen = received as KeyboardEvent;
  };
  document.addEventListener('keydown', listener);
  target.dispatchEvent(event);
  document.removeEventListener('keydown', listener);
  if (seen === null) {
    throw new Error('keydown did not reach the document');
  }
  return seen;
}

describe('isCommandsShortcut', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    { key: 'k', code: 'KeyK' },
    { key: 'K', code: 'KeyK' },
    { key: 'л', code: 'KeyK' },
    { key: 'Л', code: '' },
  ])('is K on any layout ($key)', (init) => {
    expect(isCommandsShortcut(keydown(init))).toBe(true);
  });

  it('is not another letter', () => {
    expect(isCommandsShortcut(keydown({ key: 'j', code: 'KeyJ' }))).toBe(false);
  });

  it.each(['metaKey', 'ctrlKey', 'altKey'] as const)('is not K with %s', (modifier) => {
    expect(isCommandsShortcut(keydown({ key: 'k', code: 'KeyK', [modifier]: true }))).toBe(false);
  });

  it.each(['input', 'textarea', 'select'])('is not K typed into a %s', (tag) => {
    const field = document.body.appendChild(document.createElement(tag));
    expect(isCommandsShortcut(keydown({ key: 'k', code: 'KeyK' }, field))).toBe(false);
  });

  it('is not K inside an editable region, but is inside one switched off', () => {
    const editable = document.body.appendChild(document.createElement('div'));
    editable.setAttribute('contenteditable', 'true');
    const inner = editable.appendChild(document.createElement('span'));
    expect(isCommandsShortcut(keydown({ key: 'k', code: 'KeyK' }, inner))).toBe(false);

    const off = document.body.appendChild(document.createElement('div'));
    off.setAttribute('contenteditable', 'false');
    expect(isCommandsShortcut(keydown({ key: 'k', code: 'KeyK' }, off))).toBe(true);
  });

  it('is not K another handler already took', () => {
    const button = document.body.appendChild(document.createElement('button'));
    button.addEventListener('keydown', (event) => event.preventDefault());
    expect(isCommandsShortcut(keydown({ key: 'k', code: 'KeyK' }, button))).toBe(false);
  });
});
