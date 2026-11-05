import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';

/** How long the button reads "Copied" before it reads "Copy" again (#104 UX spec §5). */
export const COPY_CODE_CONFIRM_MS = 2000;

/**
 * A command the owner runs elsewhere, as selectable code beside a Copy button. Copying announces `copiedLabel`
 * politely and swaps the visible label for two seconds, while the button's accessible name stays `ariaLabel`. A
 * clipboard that is missing or refused shows `failedNote`; the code stays selectable text, so it can be copied by
 * hand. Every text comes translated from the caller.
 *
 * ```html
 * <tc-copy-code code="setup --env stage" [ariaLabel]="…" [copyLabel]="…" [copiedLabel]="…" [failedNote]="…" />
 * ```
 */
@Component({
  selector: 'tc-copy-code',
  imports: [Button, Icon],
  template: `
    <div class="tc-code-row">
      <code class="tc-code-row__code tc-copy-code__code" data-testid="copy-code-text">{{ code() }}</code>
      <button
        tc-button
        size="sm"
        type="button"
        class="tc-copy-code__button"
        data-testid="copy-code-button"
        [attr.aria-label]="ariaLabel() || null"
        (click)="copy()"
      >
        <tc-icon name="copy" size="sm" />
        <span [attr.aria-hidden]="ariaLabel() ? 'true' : null">{{
          copied() ? copiedLabel() : copyLabel()
        }}</span>
      </button>
    </div>
    @if (failed()) {
      <p class="tc-copy-code__failed" role="status">{{ failedNote() }}</p>
    }
  `,
  styleUrl: './copy-code.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-copy-code' },
})
export class CopyCode {
  private readonly announcer = inject(LiveAnnouncer);
  private readonly clipboard = inject(DOCUMENT).defaultView?.navigator.clipboard ?? null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly code = input.required<string>();
  /** The button's accessible name when the visible "Copy" says less ("Copy the command for VAPID_PRIVATE_KEY"). */
  readonly ariaLabel = input('');
  readonly copyLabel = input.required<string>();
  readonly copiedLabel = input.required<string>();
  readonly failedNote = input.required<string>();

  protected readonly copied = signal(false);
  protected readonly failed = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  protected async copy(): Promise<void> {
    this.failed.set(false);
    try {
      if (this.clipboard === null) {
        throw new Error('clipboard unavailable');
      }
      await this.clipboard.writeText(this.code());
    } catch {
      // Denied permission or no clipboard (an insecure origin): say so; the code stays selectable.
      this.copied.set(false);
      this.failed.set(true);
      return;
    }
    this.copied.set(true);
    this.clearTimer();
    this.timer = setTimeout(() => this.copied.set(false), COPY_CODE_CONFIRM_MS);
    await this.announcer.announce(this.copiedLabel(), 'polite');
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
