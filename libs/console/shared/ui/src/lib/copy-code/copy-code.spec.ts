import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { COPY_CODE_CONFIRM_MS, CopyCode } from './copy-code';

@Component({
  imports: [CopyCode],
  template: `<tc-copy-code
    code="setup --env stage"
    ariaLabel="Copy the command for OWNER_EMAIL"
    copyLabel="Copy"
    copiedLabel="Copied"
    failedNote="Couldn't copy"
  />`,
})
class Host {}

describe('CopyCode', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let announce: ReturnType<typeof vi.fn>;

  async function render(): Promise<{
    root: HTMLElement;
    button: HTMLButtonElement;
    stable: () => Promise<void>;
  }> {
    announce = vi.fn(async () => undefined);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [{ provide: LiveAnnouncer, useValue: { announce } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const button = root.querySelector('button') as HTMLButtonElement;
    return { root, button, stable: () => fixture.whenStable() };
  }

  beforeEach(() => {
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the code as text and names the button for what it copies', async () => {
    const { root, button } = await render();
    expect(root.querySelector('code')?.textContent).toBe('setup --env stage');
    expect(button.getAttribute('aria-label')).toBe('Copy the command for OWNER_EMAIL');
    expect(button.textContent?.trim()).toBe('Copy');
  });

  it('copies, announces Copied and reads Copy again after two seconds', async () => {
    const { button, stable } = await render();
    vi.useFakeTimers();

    button.click();
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith('Copied', 'polite'));
    await stable();
    expect(writeText).toHaveBeenCalledWith('setup --env stage');
    expect(button.textContent?.trim()).toBe('Copied');
    expect(button.getAttribute('aria-label')).toBe('Copy the command for OWNER_EMAIL');

    vi.advanceTimersByTime(COPY_CODE_CONFIRM_MS);
    await stable();
    expect(button.textContent?.trim()).toBe('Copy');
  });

  it('says it could not copy when the clipboard refuses, and keeps the code', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const { root, button, stable } = await render();

    button.click();
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')).not.toBeNull());
    await stable();

    expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe("Couldn't copy");
    expect(announce).not.toHaveBeenCalled();
    expect(root.querySelector('code')?.textContent).toBe('setup --env stage');
  });
});
