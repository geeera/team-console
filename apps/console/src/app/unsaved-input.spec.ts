import { hasUnsavedField } from './unsaved-input';

describe('hasUnsavedField', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function add<K extends 'input' | 'textarea'>(
    tag: K,
    setup: (field: HTMLElementTagNameMap[K]) => void = () => undefined,
  ) {
    const field = document.createElement(tag);
    setup(field);
    document.body.append(field);
    return field;
  }

  it('is false for a page with untouched fields', () => {
    add('input', (field) => (field.defaultValue = 'as rendered'));
    add('textarea');

    expect(hasUnsavedField(document)).toBe(false);
  });

  it('is true for typed text in a text input or a textarea', () => {
    add('input').value = 'draft';
    expect(hasUnsavedField(document)).toBe(true);

    document.body.replaceChildren();
    add('textarea').value = 'a reason';
    expect(hasUnsavedField(document)).toBe(true);
  });

  it('is true for a field cleared from what it was rendered with', () => {
    add('input', (field) => (field.defaultValue = 'storify')).value = '';

    expect(hasUnsavedField(document)).toBe(true);
  });

  it('is true while a text field has focus, even an empty one', () => {
    add('input', (field) => (field.type = 'search')).focus();

    expect(hasUnsavedField(document)).toBe(true);
  });

  it('ignores controls that hold no typed text, and disabled or read-only fields', () => {
    add('input', (field) => {
      field.type = 'checkbox';
      field.value = 'on-changed';
    }).focus();
    add('input', (field) => (field.disabled = true)).value = 'x';
    add('textarea', (field) => (field.readOnly = true)).value = 'x';

    expect(hasUnsavedField(document)).toBe(false);
  });
});
