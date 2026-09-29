import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Button, ButtonVariant } from './button';

@Component({
  imports: [Button],
  template: '<button tc-button [variant]="variant()" type="button">Save</button>',
})
class Host {
  readonly variant = signal<ButtonVariant>('secondary');
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
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    return { host: fixture.componentInstance, button, stabilise: () => fixture.whenStable() };
  }

  it('keeps the native button and projects its label', async () => {
    const { button } = await render();

    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent?.trim()).toBe('Save');
    expect(button.classList.contains('tc-button')).toBe(true);
    expect(button.classList.contains('tc-button--secondary')).toBe(true);
  });

  it('switches the variant class from its input', async () => {
    const { host, button, stabilise } = await render();

    host.variant.set('primary');
    await stabilise();

    expect(button.classList.contains('tc-button--primary')).toBe(true);
    expect(button.classList.contains('tc-button--secondary')).toBe(false);
  });
});
