import { DOCUMENT } from '@angular/common';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NetworkStatus } from '@console/shared/api';
import { TranslocoPipe } from '@console/shared/i18n';
import { Button, ButtonVariant, Icon } from '@console/shared/ui';
import { GitHubConnectionStore } from './github-connection.store';

/** Why Connect did not leave for GitHub: an address that is not GitHub's authorize page, or a refused start. */
export type ConnectRefusal = 'url' | 'start';

/**
 * "Connect GitHub" wherever the console needs the owner connection (Settings, New project, a setup page). It
 * leaves for GitHub only through `GitHubConnectionStore.connect()`; otherwise it stays and reports why, and the
 * host shows the error block. `aria-disabled` (never `disabled`) offline and while GitHub opens, so focus stays.
 */
@Component({
  selector: 'tc-connect-github-button',
  imports: [Button, Icon, TranslocoPipe],
  template: `
    <button
      tc-button
      type="button"
      [variant]="variant()"
      [block]="block()"
      [attr.aria-disabled]="busy() || !network.online() ? 'true' : null"
      (click)="start()"
    >
      <tc-icon name="github" />
      {{ (busy() ? 'settings.gh.connecting' : 'settings.gh.connect') | transloco }}
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-connect-github-button' },
})
export class ConnectGitHubButton {
  private readonly store = inject(GitHubConnectionStore);
  protected readonly network = inject(NetworkStatus);

  readonly variant = input<ButtonVariant>('primary');
  readonly block = input(false, { transform: booleanAttribute });
  readonly refused = output<ConnectRefusal>();

  protected readonly busy = signal(false);

  constructor() {
    // Back from GitHub through the back/forward cache restores this page as it was left: busy. Reset it.
    const view = inject(DOCUMENT).defaultView;
    const reset = (): void => this.busy.set(false);
    view?.addEventListener('pageshow', reset);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('pageshow', reset));
  }

  protected async start(): Promise<void> {
    if (this.busy() || !this.network.online()) {
      return;
    }
    this.busy.set(true);
    const result = await this.store.connect();
    if (result.kind === 'navigating') {
      // The page is leaving for GitHub; staying busy keeps a second tap from starting another attempt.
      return;
    }
    this.busy.set(false);
    this.refused.emit(result.kind === 'refused-url' ? 'url' : 'start');
  }
}
