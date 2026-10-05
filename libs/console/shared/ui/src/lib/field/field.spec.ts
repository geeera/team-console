import { ApplicationInitStatus, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideConsoleI18n } from '@console/shared/i18n';
import { Field, FieldControl } from './field';

@Component({
  imports: [Field, FieldControl],
  template: `
    <tc-field label="Repository" [hint]="hint()" [error]="error()" [note]="note()" [required]="required()">
      <input tcInput type="text" />
    </tc-field>
  `,
})
class Host {
  readonly hint = signal('owner/repo');
  readonly error = signal('');
  readonly note = signal('');
  readonly required = signal(true);
}

describe('Field', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideConsoleI18n()],
    }).compileComponents();
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('input') as HTMLInputElement;
    const label = root.querySelector('label') as HTMLLabelElement;
    return { fixture, root, input, label };
  }

  it('links the label to the control and the hint to its description', async () => {
    const { root, input, label } = await render();

    expect(input.id).not.toBe('');
    expect(label.htmlFor).toBe(input.id);
    const hint = root.querySelector('.tc-field__hint') as HTMLElement;
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(label.textContent).not.toContain('необязательно');
  });

  it('replaces the hint with an alert and marks the control invalid on error', async () => {
    const { fixture, root, input } = await render();

    fixture.componentInstance.error.set('Not owner/repo');
    await fixture.whenStable();

    const error = root.querySelector('.tc-field__error') as HTMLElement;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent?.trim()).toBe('Not owner/repo');
    expect(root.querySelector('.tc-field__hint')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('adds the note to the description next to the hint or the error', async () => {
    const { fixture, root, input } = await render();

    fixture.componentInstance.note.set('Address: /p/storify');
    await fixture.whenStable();
    const note = root.querySelector('.tc-field__note') as HTMLElement;
    const hint = root.querySelector('.tc-field__hint') as HTMLElement;
    expect(note.textContent?.trim()).toBe('Address: /p/storify');
    expect(input.getAttribute('aria-describedby')).toBe(`${hint.id} ${note.id}`);

    fixture.componentInstance.error.set('Not owner/repo');
    await fixture.whenStable();
    const error = root.querySelector('.tc-field__error') as HTMLElement;
    expect(input.getAttribute('aria-describedby')).toBe(`${error.id} ${note.id}`);
  });

  it('says when a field is optional', async () => {
    const { fixture, label } = await render();

    fixture.componentInstance.required.set(false);
    await fixture.whenStable();

    expect(label.textContent).toContain('(необязательно)');
  });
});
