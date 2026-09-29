import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Button, ButtonVariant, IconButton } from './button';

@Component({
  imports: [Button, IconButton],
  template: `
    <button tc-button [variant]="variant()" [loading]="loading()" type="button">Save</button>
    <button tc-icon-button type="button" aria-label="Close">x</button>
  `,
})
class Host {
  readonly variant = signal<ButtonVariant>('secondary');
  readonly loading = signal(false);
}

describe('Button', () => {
  async function render(): Promise<{
    host: Host;
    button: HTMLButtonElement;
    stabilise: () => Promise<void>;
  }> {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button[tc-button]') as HTMLButtonElement;
    return { host: fixture.componentInstance, button, stabilise: () => fixture.whenStable() };
  }

  it('keeps the native button and projects its label', async () => {
    const { button } = await render();

    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent?.trim()).toBe('Save');
    expect(button.classList.contains('tc-button--secondary')).toBe(true);
  });

  it('switches the variant class from its input', async () => {
    const { host, button, stabilise } = await render();

    host.variant.set('danger');
    await stabilise();

    expect(button.classList.contains('tc-button--danger')).toBe(true);
    expect(button.classList.contains('tc-button--secondary')).toBe(false);
  });

  it('announces aria-busy and shows the spinner while loading', async () => {
    const { host, button, stabilise } = await render();
    expect(button.getAttribute('aria-busy')).toBeNull();

    host.loading.set(true);
    await stabilise();

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('tc-spinner')).not.toBeNull();
  });

  it('renders the icon button as a native button with its label', async () => {
    await render();
    const icon = TestBed.createComponent(Host).nativeElement.querySelector(
      'button[tc-icon-button]',
    ) as HTMLButtonElement;

    expect(icon.classList.contains('tc-icon-button')).toBe(true);
    expect(icon.getAttribute('aria-label')).toBe('Close');
  });
});
