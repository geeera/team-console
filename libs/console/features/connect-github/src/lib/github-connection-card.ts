import { LiveAnnouncer } from '@angular/cdk/a11y';
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
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  ConnectGitHubButton,
  GitHubConnectionStore,
  type ConnectOutcome,
  type ConnectRefusal,
} from '@console/entities/github-connection';
import { NetworkStatus } from '@console/shared/api';
import { LocalDayPipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, Sheet, StateBlock, Toaster } from '@console/shared/ui';

/** Why the last connect did not work: the callback's outcome, or what the client refused before leaving. */
type ConnectError =
  | { readonly kind: 'denied' | 'failed' | 'url' | 'start' }
  | { readonly kind: 'wrong-account'; readonly who: string | null };

/**
 * The GitHub connection block at the top of Settings (#24, the UI of #59): connected as / Disconnect, Connect,
 * the "connection lost" warning, and why a connect failed. Every state is the Worker's; the card only reads the
 * store and the callback outcome it is given.
 */
@Component({
  selector: 'tc-github-connection-card',
  imports: [Button, ConnectGitHubButton, Icon, LocalDayPipe, StateBlock, TranslocoPipe],
  templateUrl: './github-connection-card.html',
  styleUrl: './github-connection-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitHubConnectionCard {
  private readonly sheet = inject(Sheet);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly injector = inject(Injector);

  protected readonly store = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);

  /** The `?github=` outcome the OAuth callback came back with, once per return. */
  readonly outcome = input<ConnectOutcome | null>(null);

  protected readonly error = signal<ConnectError | null>(null);
  protected readonly manageUrl = signal<string | null | undefined>(undefined);

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');

  protected readonly errorKey = computed(() => {
    const error = this.error();
    return error === null
      ? null
      : `settings.gh.error.${error.kind === 'wrong-account' ? 'account' : error.kind}`;
  });
  protected readonly errorParams = computed(() => {
    const error = this.error();
    return {
      who: error?.kind === 'wrong-account' ? (error.who ?? '?') : '',
      login: this.store.ownerLogin() ?? '',
    };
  });

  constructor() {
    // Re-read on every visit: a connection that ended since Settings last showed it must read as lost (#24 AC 2).
    void this.store.load();
    effect(() => {
      const outcome = this.outcome();
      untracked(() => void this.applyOutcome(outcome));
    });
  }

  protected onRefused(reason: ConnectRefusal): void {
    this.error.set({ kind: reason });
    this.focusTitle();
  }

  protected retry(): void {
    void this.store.load();
  }

  protected async disconnect(): Promise<void> {
    if (!this.network.online()) {
      return;
    }
    const login = this.store.login() ?? '';
    let incomplete: string | null | undefined;
    const confirmed = await this.sheet.confirm({
      title: this.transloco.translate('settings.disc.title'),
      message: this.transloco.translate('settings.disc.body', { login }),
      confirmLabel: this.transloco.translate('settings.disc.confirm'),
      busyLabel: this.transloco.translate('settings.disc.busy'),
      errorMessage: this.transloco.translate('settings.disc.error'),
      tone: 'danger',
      action: async () => {
        const result = await this.store.disconnect();
        incomplete = result.kind === 'revoke-on-github' ? result.manageUrl : undefined;
      },
    });
    if (!confirmed) {
      return;
    }
    this.error.set(null);
    this.manageUrl.set(incomplete);
    this.toaster.show(this.transloco.translate('settings.disc.toast'));
    this.focusTitle();
  }

  private async applyOutcome(outcome: ConnectOutcome | null): Promise<void> {
    if (outcome === null) {
      return;
    }
    if (outcome.kind !== 'connected') {
      this.error.set(
        outcome.kind === 'wrong-account'
          ? { kind: 'wrong-account', who: outcome.login }
          : { kind: outcome.kind },
      );
      this.focusTitle();
      return;
    }
    this.error.set(null);
    // Server-driven: the login announced is the one the Worker reports after the callback, not the URL's.
    await this.store.load();
    const login = this.store.login();
    if (login !== null) {
      this.focusTitle();
      await this.announcer.announce(
        this.transloco.translate('settings.gh.connectedLive', { login }),
        'polite',
      );
    }
  }

  private focusTitle(): void {
    afterNextRender(() => this.title()?.nativeElement.focus(), { injector: this.injector });
  }
}
