import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { notReadyMessageOf } from '@console/entities/actions-setup';
import { RunnersApi, runnerFailureKeyOf, type RunnerFailure } from '@console/entities/runner';
import { NetworkStatus } from '@console/shared/api';
import { TranslocoPipe, TranslocoPluralPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, Icon } from '@console/shared/ui';
import { ACTIONS_NOT_READY, type ActionsSetupDto, type ProjectDispatchDto } from '@shared/contracts';

/**
 * Step 5 (#759 UX spec §3.5): «Включить» sends `PUT …/dispatch {actions}` through the runners entity, so a customer
 * finishes where they did the work. It is `aria-disabled` while steps 1–4 are not done, and activating it then asks
 * the page to move focus to the first missing step. The server's 422 `actions-not-ready` stays the backstop: its
 * items are named and the page checks again. Switching back to `pull` lives in Runners.
 */
@Component({
  selector: 'tc-actions-switch-on',
  imports: [Banner, Button, Icon, RouterLink, TranslocoPipe, TranslocoPluralPipe],
  template: `
    @if (setup().dispatch === 'actions') {
      <p class="switch__fix" data-testid="switch-done">{{ 'actions.switch.done' | transloco }}</p>
      <a class="switch__link" routerLink="/settings/runners" data-testid="switch-change">
        {{ 'actions.switch.change' | transloco }}<tc-icon name="chevron-right" size="sm" />
      </a>
    } @else {
      @if (setup().ready) {
        <p class="switch__fix">{{ 'actions.switch.ready' | transloco }}</p>
      }
      @if (failure(); as message) {
        <div tc-banner tone="danger" role="alert" data-testid="switch-error">
          <tc-icon tc-banner-icon name="alert" size="sm" />
          <p tc-banner-text>{{ message }}</p>
        </div>
        @if (isAccessSourceRefusal() && teamUrl(); as url) {
          <a tc-button size="sm" data-testid="switch-team" [routerLink]="url">{{ 'runners.err.openTeam' | transloco }}</a>
        }
      }
      <div class="switch__actions">
        <button
          tc-button
          type="button"
          data-testid="switch-on"
          [variant]="setup().ready ? 'primary' : 'secondary'"
          [loading]="saving()"
          [attr.aria-disabled]="isBlocked() ? 'true' : null"
          [attr.aria-describedby]="isBlocked() ? id + '-why' : null"
          (click)="switchOn()"
        >
          {{ (saving() ? 'actions.switch.busy' : 'actions.switch.on') | transloco }}
        </button>
      </div>
      @if (!setup().ready) {
        <p class="switch__why" [id]="id + '-why'" data-testid="switch-blocked">
          {{ 'actions.switch.blocked' | translocoPlural: missing() }}
        </p>
      } @else if (!network.online()) {
        <p class="switch__why" [id]="id + '-why'">{{ 'actions.err.offlineWhy' | transloco }}</p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
    }
    .switch__fix,
    .switch__why {
      margin: 0;
      font-size: var(--fs-sm);
      line-height: var(--lh-body);
      color: var(--text-2);
    }
    .switch__why {
      font-size: var(--fs-xs);
    }
    .switch__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .switch__link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-height: var(--control-h-touch);
      color: var(--accent-text);
      font-size: var(--fs-sm);
      font-weight: var(--fw-semibold);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionsSwitchOn {
  private static nextId = 0;
  private readonly api = inject(RunnersApi);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  protected readonly network = inject(NetworkStatus);

  readonly slug = input.required<string>();
  readonly projectName = input.required<string>();
  readonly setup = input.required<ActionsSetupDto>();
  /** Steps 1–4 that are not done; at least 1 while the server says not ready. */
  readonly missing = input.required<number>();
  /** Settings › Team, linked from an `access-source-hosted` refusal. */
  readonly teamUrl = input<string | null>(null);

  readonly switched = output<ProjectDispatchDto>();
  /** The switch was activated while not ready: the page moves focus to the first step that is not done. */
  readonly blockedActivation = output<void>();
  /** The server refused with `actions-not-ready`: the page's answer is stale. */
  readonly recheck = output<void>();

  protected readonly id = `tc-actions-switch-${ActionsSwitchOn.nextId++}`;
  protected readonly saving = signal(false);
  private readonly lastFailure = signal<RunnerFailure | null>(null);

  protected readonly isBlocked = computed(() => !this.setup().ready || this.saving() || !this.network.online());
  protected readonly isAccessSourceRefusal = computed(() => this.lastFailure()?.slug === 'access-source-hosted');
  protected readonly failure = computed(() => {
    const failure = this.lastFailure();
    if (failure === null) {
      return null;
    }
    if (failure.slug === ACTIONS_NOT_READY) {
      return notReadyMessageOf(failure.items ?? [], this.projectName(), (key, params) => this.t(key, params));
    }
    return this.t(runnerFailureKeyOf(failure));
  });

  protected async switchOn(): Promise<void> {
    if (!this.setup().ready) {
      this.blockedActivation.emit();
      return;
    }
    if (this.isBlocked()) {
      return;
    }
    const slug = this.slug();
    this.saving.set(true);
    this.lastFailure.set(null);
    const result = await this.api.setDispatch(slug, 'actions');
    this.saving.set(false);
    if (this.slug() !== slug) {
      return;
    }
    if (!result.ok) {
      this.lastFailure.set(result.failure);
      if (result.failure.slug === ACTIONS_NOT_READY) {
        this.recheck.emit();
      }
      return;
    }
    this.switched.emit(result.value);
    await this.announcer.announce(this.t('actions.switch.doneLive'), 'polite');
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.transloco.translate(key, params);
  }
}
