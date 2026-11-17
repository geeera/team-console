import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { InstallPrompt } from '@console/shared/platform';
import { AppTile, Button, HomeScreenGuide, Icon, IconButton, isPhoneSignal, Toaster } from '@console/shared/ui';
import { injectAppName } from './app-name';
import { InstallOffer } from './install-offer';

let nextId = 0;

/**
 * The install offer at the top of a landing screen (#761, approved design): in the page flow, never fixed or
 * sticky, so it can never cover the phone's bottom bar (#368). One tap opens Chromium's own dialog; on iOS the
 * Home Screen steps open inside the card; on macOS Safari it is one line. Not now, Don't show again and the success
 * line's close emit `dismissed`, and the page moves focus to its heading.
 */
@Component({
  selector: 'tc-install-card',
  imports: [AppTile, Button, HomeScreenGuide, Icon, IconButton, TranslocoPipe],
  templateUrl: './install-card.html',
  styleUrl: './install-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstallCard {
  private readonly offer = inject(InstallOffer);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);

  protected readonly prompt = inject(InstallPrompt);
  protected readonly appName = injectAppName();
  protected readonly isPhone = isPhoneSignal();

  /** The screen has its content (Needs you: the projects are loaded); the card never shows over a loading one. */
  readonly ready = input(false);
  readonly dismissed = output<void>();

  protected readonly ids = { title: `tc-install-title-${nextId}`, steps: `tc-install-steps-${nextId++}` };
  protected readonly isGuideOpen = signal(false);
  protected readonly hasFailed = signal(false);
  private readonly isDone = signal(false);

  private readonly doneLine = viewChild<ElementRef<HTMLElement>>('doneLine');

  protected readonly variant = computed(() => {
    if (!this.offer.isShownHere()) {
      return 'hidden';
    }
    if (this.isDone() || this.prompt.installedNow()) {
      return 'done';
    }
    switch (this.prompt.path()) {
      case 'native':
        return 'native';
      case 'ios':
      case 'ios-other':
        return 'ios';
      case 'mac':
        return 'mac';
      default:
        return 'hidden';
    }
  });
  protected readonly isOtherIosBrowser = computed(() => this.prompt.path() === 'ios-other');
  protected readonly bodyKey = computed(() => {
    switch (this.prompt.path()) {
      case 'ios':
        return 'install.card.bodyIos';
      case 'ios-other':
        return 'install.card.bodyIosOther';
      default:
        return this.isPhone() ? 'install.card.bodyPhone' : 'install.card.bodyDesktop';
    }
  });

  constructor() {
    effect(() => {
      const screen = this.offer.screen();
      if (this.ready() && screen !== null) {
        untracked(() => this.offer.present(screen));
      }
    });
  }

  protected async install(): Promise<void> {
    if (this.prompt.isPrompting()) {
      return;
    }
    this.hasFailed.set(false);
    const outcome = await this.prompt.prompt();
    switch (outcome) {
      case 'accepted':
        this.offer.installed();
        this.isDone.set(true);
        // The Install button is gone with the offer: focus goes to the line that says what happened.
        afterNextRender(() => this.doneLine()?.nativeElement.focus(), { injector: this.injector });
        return;
      case 'dismissed':
        this.answer('later');
        return;
      case 'failed':
        this.hasFailed.set(true);
        return;
    }
  }

  protected toggleGuide(): void {
    this.isGuideOpen.update((open) => !open);
  }

  protected answer(choice: 'later' | 'never'): void {
    this.offer.answer(choice);
    this.toaster.show(this.transloco.translate('install.toast'));
    this.dismissed.emit();
  }

  protected closeDone(): void {
    this.offer.close();
    this.dismissed.emit();
  }
}
