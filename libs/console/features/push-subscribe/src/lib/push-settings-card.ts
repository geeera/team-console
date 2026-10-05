import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import { NeedsYouCounts } from '@console/entities/project';
import { PushStore } from '@console/entities/push';
import { NetworkStatus } from '@console/shared/api';
import {
  isConsoleLang,
  LocalDayPipe,
  localNumberOf,
  pluralKeyOf,
  TranslocoPipe,
  TranslocoPluralPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Platform } from '@console/shared/platform';
import { Button, Callout, Icon, StatusCard, Toaster } from '@console/shared/ui';
import { InstallGuide } from './install-guide';

let nextId = 0;

/**
 * The Notifications block of Settings (#36): every state of web push on this device, from the approved design.
 * Permission is asked only from Turn on's click; Check again only re-reads. The card never decides a state itself:
 * `PushStore` does, from the browser and the Worker.
 */
@Component({
  selector: 'tc-push-settings-card',
  imports: [Button, Callout, Icon, InstallGuide, LocalDayPipe, StatusCard, TranslocoPipe, TranslocoPluralPipe],
  templateUrl: './push-settings-card.html',
  styleUrl: './push-settings-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PushSettingsCard {
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly toaster = inject(Toaster);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly store = inject(PushStore);
  protected readonly network = inject(NetworkStatus);
  protected readonly needsYou = inject(NeedsYouCounts);
  protected readonly platform = inject(Platform).info;
  /** Safari's settings list the site by its host; it is this page's own, never data from a link. */
  protected readonly siteHost = inject(DOCUMENT).location.host;

  protected readonly ids = { offline: `tc-push-offline-${nextId++}` };

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');

  /** Turning on, waiting and a failed save share the "off" card; the unsupported reasons share one card. */
  protected readonly card = computed(() => {
    const view = this.store.view();
    switch (view) {
      case 'asking':
      case 'saving':
        return 'off';
      case 'old-ios':
      case 'in-app':
      case 'no-push':
        return 'unsupported';
      default:
        return view;
    }
  });
  protected readonly deniedKey = computed(() => `push.denied.${this.platform.settingsHost}`);
  protected readonly enableKey = computed(() => {
    switch (this.store.phase()) {
      case 'asking':
        return 'push.asking';
      case 'saving':
        return 'push.saving';
      default:
        return this.store.hasPendingSave() ? 'push.retry' : 'push.enable';
    }
  });
  /** The device asks only while the permission is undecided; once granted, Turn on goes straight to saving. */
  protected readonly showsHint = computed(
    () => this.store.permission() === 'default' && !this.store.isBusy() && this.store.failure() === null,
  );

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
    switch (this.store.view()) {
      case 'on':
        this.focus('title');
        await this.announce('push.onLive');
        return;
      case 'denied':
        this.focus('title');
        await this.announce('push.deniedLive');
        return;
      default:
        if (this.store.failure() !== null) {
          this.focus('failure');
        }
    }
  }

  protected async recheck(): Promise<void> {
    await this.store.refresh();
    this.focus('title');
    await this.announce(this.store.view() === 'denied' ? 'push.recheckStill' : 'push.recheckLive');
  }

  protected async sendTest(): Promise<void> {
    if (!this.network.online()) {
      await this.announce('push.offline');
      return;
    }
    const lang = this.transloco.getActiveLang();
    await this.store.sendTest(isConsoleLang(lang) ? lang : 'ru');
    const outcome = this.store.testOutcome();
    if (outcome === null) {
      return;
    }
    const message =
      outcome.kind === 'sent'
        ? `${this.transloco.translate('push.test.sent')}. ${this.transloco.translate(
            pluralKeyOf('push.test.sentBody', lang, outcome.devices),
            { n: localNumberOf(outcome.devices, lang) },
          )}`
        : outcome.kind === 'wait'
          ? this.transloco.translate('push.test.wait', { s: outcome.seconds })
          : this.transloco.translate('push.test.failed');
    await this.announcer.announce(message, 'polite');
  }

  protected async turnOff(): Promise<void> {
    if (!this.network.online()) {
      await this.announce('push.offline');
      return;
    }
    const result = await this.store.turnOff();
    if (result === 'off') {
      this.toaster.show(this.transloco.translate('push.offToast'));
      this.focus('enable');
    } else {
      this.toaster.show(this.transloco.translate('push.offFailed'));
    }
  }

  private focus(target: 'title' | 'failure' | 'enable'): void {
    afterNextRender(
      () => {
        const element =
          target === 'title'
            ? this.title()?.nativeElement
            : this.host.nativeElement.querySelector<HTMLElement>(`[data-focus="${target}"]`);
        element?.focus();
      },
      { injector: this.injector },
    );
  }

  private announce(key: string): Promise<void> {
    return this.announcer.announce(this.transloco.translate(key), 'polite');
  }
}
