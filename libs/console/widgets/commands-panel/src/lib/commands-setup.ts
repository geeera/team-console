import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon } from '@console/shared/ui';
import type { TeamSlot } from '@shared/contracts';

/** One slot without a trigger token: its name and the two `wrangler secret put` lines that set it up. */
export interface SetupLine {
  readonly slot: TeamSlot;
  readonly name: string;
  readonly commands: readonly { readonly what: 'id' | 'token'; readonly text: string }[];
}

/** What the setup card says: the slots in words ("QA", "planning and QA") and their lines. */
export interface SetupView {
  readonly names: string;
  readonly lines: readonly SetupLine[];
}

let nextSetupId = 0;

/**
 * The Run now group's setup card (#114): a to-do in ochre for slots without a trigger token, with the steps behind
 * "How to set up" and a copy button per command. Its own component so its styles are its own (#123: the panel's
 * stylesheet stays under the per-component budget).
 */
@Component({
  selector: 'tc-commands-setup',
  imports: [Button, Icon, TranslocoPipe],
  templateUrl: './commands-setup.html',
  styleUrl: './commands-setup.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandsSetup {
  private readonly document = inject(DOCUMENT);
  private readonly transloco = inject(TranslocoService);

  readonly setup = input.required<SetupView>();
  readonly projectName = input.required<string>();
  /** A sentence for the panel's live region ("Copied"). */
  readonly announced = output<string>();

  protected readonly id = `tc-cs-${nextSetupId++}`;
  protected readonly isHowOpen = signal(false);
  protected readonly copied = signal<string | null>(null);

  protected async copy(text: string, event: Event): Promise<void> {
    const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(text);
    } catch (error: unknown) {
      // No clipboard (an insecure origin, a denied permission): select the line so it can be copied by hand.
      console.warn('clipboard unavailable; the command is selected instead', error);
      const code = button?.parentElement?.querySelector('code');
      const selection = this.document.getSelection();
      if (code !== null && code !== undefined && selection !== null) {
        selection.selectAllChildren(code);
      }
      return;
    }
    this.copied.set(text);
    this.announced.emit(this.transloco.translate('commands.setup.copied'));
    setTimeout(() => {
      if (this.copied() === text) {
        this.copied.set(null);
      }
    }, 2400);
  }
}
