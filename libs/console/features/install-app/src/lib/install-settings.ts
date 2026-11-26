import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { InstallPrompt, type InstallPath } from '@console/shared/platform';
import {
  AppTile,
  Button,
  Chip,
  COPY_CODE_CONFIRM_MS,
  HomeScreenGuide,
  Icon,
  List,
  ListRow,
} from '@console/shared/ui';
import { injectAppName } from './app-name';
import { InstallMemoryStore } from './install-memory';

let nextId = 0;

const SUBTITLES: Record<InstallPath, string> = {
  standalone: 'settings.app.subStandalone',
  installed: 'settings.app.subJustInstalled',
  native: 'settings.app.subNative',
  menu: 'settings.app.subMenu',
  ios: 'settings.app.subIos',
  'ios-other': 'settings.app.subIos',
  'in-app': 'settings.app.subInApp',
  mac: 'settings.app.subMac',
  'mac-old': 'settings.app.subMacOld',
  none: 'settings.app.subUnsupported',
};

/**
 * Settings › App (#761): this device's install state and the one action this browser allows. The card's snooze
 * and never never hide it; it always shows the current path. The page owns the section heading.
 */
@Component({
  selector: 'tc-install-settings',
  imports: [AppTile, Button, Chip, HomeScreenGuide, Icon, List, ListRow, TranslocoPipe],
  templateUrl: './install-settings.html',
  styleUrl: './install-settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallSettings {
  private readonly memory = inject(InstallMemoryStore);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly view = inject(DOCUMENT).defaultView;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly prompt = inject(InstallPrompt);
  protected readonly appName = injectAppName();

  /** The id of the page's section heading, which names the list. */
  readonly labelledBy = input.required<string>();
  /** The control that had focus is gone (installed, or the browser's event spent): the page refocuses its heading. */
  readonly focusLost = output<void>();

  protected readonly ids = { steps: `tc-install-settings-steps-${nextId++}` };
  protected readonly isGuideOpen = signal(false);
  protected readonly hasFailed = signal(false);
  protected readonly isCopied = signal(false);
  protected readonly hasCopyFailed = signal(false);

  protected readonly path = computed(() => this.prompt.path());
  protected readonly isInstalled = computed(
    () => this.path() === 'standalone' || this.path() === 'installed',
  );
  protected readonly isIos = computed(() => this.path() === 'ios' || this.path() === 'ios-other');
  protected readonly subtitleKey = computed(() => SUBTITLES[this.path()]);
  protected readonly chip = computed<'on' | 'off' | null>(() => {
    if (this.isInstalled()) {
      return 'on';
    }
    return this.path() === 'native' || this.isIos() ? 'off' : null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.copiedTimer !== null) {
        clearTimeout(this.copiedTimer);
      }
    });
  }

  /** "How to add it" from Notifications or the Needs you nudge: the steps open here, the one place they live. */
  openGuide(): void {
    if (this.isIos()) {
      this.isGuideOpen.set(true);
    }
  }

  protected toggleGuide(): void {
    this.isGuideOpen.update((open) => !open);
  }

  protected async install(): Promise<void> {
    if (this.prompt.isPrompting()) {
      return;
    }
    this.hasFailed.set(false);
    const outcome = await this.prompt.prompt();
    if (outcome === 'failed') {
      this.hasFailed.set(true);
      return;
    }
    if (outcome === 'accepted') {
      this.memory.clear();
    }
    // Accepted or dismissed, the event is spent and the Install button with it.
    this.focusLost.emit();
  }

  /** The address to open in Safari: the console's start page, never a link from data. */
  protected async copyLink(): Promise<void> {
    this.hasCopyFailed.set(false);
    const clipboard = this.view?.navigator.clipboard;
    const origin = this.view?.location.origin;
    try {
      if (clipboard === undefined || origin === undefined) {
        throw new Error('clipboard unavailable');
      }
      await clipboard.writeText(`${origin}/`);
    } catch (error: unknown) {
      console.warn('install: could not copy the link', error);
      this.hasCopyFailed.set(true);
      return;
    }
    this.isCopied.set(true);
    await this.announcer.announce(this.transloco.translate('settings.common.copied'), 'polite');
    if (this.copiedTimer !== null) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = setTimeout(() => this.isCopied.set(false), COPY_CODE_CONFIRM_MS);
  }
}
