import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { PushStore } from '@console/entities/push';
import { NetworkStatus } from '@console/shared/api';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, Toaster } from '@console/shared/ui';
import { FOCUS_PUSH_SETTINGS_STATE, PushNudgeMemory } from './nudge-memory';

let nextId = 0;

/**
 * The quiet note on Needs you while push is off on this device (#36): that screen promises "you'll get a
 * notification", so it says when that is not true. Turn on asks for permission from this tap only; on iPhone
 * Safari it leads to the Home Screen guide in Settings instead. Not now hides it on this device.
 */
@Component({
  selector: 'tc-push-nudge',
  imports: [Button, Icon, TranslocoPipe],
  templateUrl: './push-nudge.html',
  styleUrl: './push-nudge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PushNudge {
  private readonly router = inject(Router);
  private readonly memory = inject(PushNudgeMemory);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);

  protected readonly store = inject(PushStore);
  protected readonly network = inject(NetworkStatus);

  /** The nudge went away by the owner's choice; the page moves focus to its heading. */
  readonly dismissed = output<void>();

  protected readonly ids = { text: `tc-push-nudge-${nextId}`, offline: `tc-push-nudge-offline-${nextId++}` };
  protected readonly turnedOn = signal(false);

  protected readonly isVisible = computed(() => {
    if (this.memory.isDismissed()) {
      return false;
    }
    const view = this.store.view();
    return view === 'off' || view === 'asking' || view === 'saving' || view === 'install';
  });
  protected readonly isInstall = computed(() => this.store.view() === 'install');
  protected readonly enableKey = computed(() => {
    switch (this.store.phase()) {
      case 'asking':
        return 'push.asking';
      case 'saving':
        return 'push.saving';
      default:
        return this.store.hasPendingSave() ? 'push.retry' : 'push.nudge.enable';
    }
  });

  constructor() {
    void this.store.refresh();
  }

  protected async enable(): Promise<void> {
    if (!this.network.online()) {
      await this.announce('push.offline');
      return;
    }
    if (this.store.isBusy()) {
      return;
    }
    await this.store.enable();
    if (this.store.isOn()) {
      this.turnedOn.set(true);
    } else if (this.store.view() === 'denied') {
      await this.announce('push.deniedLive');
    }
  }

  protected async how(): Promise<void> {
    await this.router.navigate(['/settings'], { state: { [FOCUS_PUSH_SETTINGS_STATE]: true } });
  }

  protected later(): void {
    this.memory.dismiss();
    this.toaster.show(this.transloco.translate('push.nudge.laterToast'));
    this.dismissed.emit();
  }

  private announce(key: string): Promise<void> {
    return this.announcer.announce(this.transloco.translate(key), 'polite');
  }
}
