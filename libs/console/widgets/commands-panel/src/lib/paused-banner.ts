import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TeamStatusStore } from '@console/entities/team-run';
import { TeamCommands } from '@console/features/team-commands';
import { NetworkStatus } from '@console/shared/api';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Banner, Button, Icon, Toaster } from '@console/shared/ui';
import type { CommandsProject } from './commands-panel';

let nextBannerId = 0;

/**
 * While the project is paused, a strip across its space (#114): ochre with Resume when the owner paused it, clay
 * with the run log and Resume when the team paused itself. Resume asks once, like the panel's; its result is a
 * toast, since the panel may be closed.
 */
@Component({
  selector: 'tc-paused-banner',
  imports: [Banner, Button, Icon, LocalTimePipe, TranslocoPipe],
  template: `
    @if (status(); as status) {
      @if (status.state !== 'running') {
        <div
          tc-banner
          data-testid="paused-banner"
          [tone]="status.state === 'paused-by-team' ? 'danger' : 'warning'"
        >
          <tc-icon tc-banner-icon [name]="status.state === 'paused-by-team' ? 'alert' : 'pause'" />
          <p tc-banner-text>
            @if (status.state === 'paused-by-team') {
              <b>{{ 'commands.banner.teamLead' | transloco: { name: project().name } }}</b>
              {{ 'commands.banner.teamRest' | transloco }}
            } @else {
              <b>{{
                status.pausedAt
                  ? ('commands.banner.ownerLead'
                    | transloco: { name: project().name, time: (status.pausedAt | localTime) })
                  : ('commands.status.ownerNoTime' | transloco)
              }}</b>
              {{ 'commands.banner.ownerRest' | transloco }}
            }
          </p>
          <div tc-banner-actions>
            @if (status.state === 'paused-by-team' && status.runLogUrl) {
              <a [href]="status.runLogUrl" target="_blank" rel="noopener noreferrer">
                {{ 'commands.banner.log' | transloco
                }}<span class="tc-sr-only"> {{ 'commands.external' | transloco }}</span>
              </a>
            }
            <button
              tc-button
              size="sm"
              type="button"
              data-testid="banner-resume"
              [off]="why() !== null"
              [attr.aria-disabled]="why() !== null ? 'true' : null"
              [attr.aria-describedby]="why() !== null ? id : null"
              (click)="resume()"
            >
              {{ 'commands.banner.resume' | transloco }}
            </button>
            @if (why(); as why) {
              <span class="tc-sr-only" [id]="id">{{ why }}</span>
            }
          </div>
        </div>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-paused-banner' },
})
export class PausedBanner {
  private readonly store = inject(TeamStatusStore);
  private readonly commands = inject(TeamCommands);
  private readonly network = inject(NetworkStatus);
  private readonly toaster = inject(Toaster);
  private readonly transloco = inject(TranslocoService);

  readonly project = input.required<CommandsProject>();

  protected readonly id = `tc-paused-banner-why-${nextBannerId++}`;
  protected readonly status = computed(() =>
    this.store.slug() === this.project().slug ? this.store.status() : null,
  );
  protected readonly why = computed(() => {
    if (!this.network.online()) {
      return this.transloco.translate('commands.why.offline');
    }
    return this.status()?.ownerConnected === false ? this.transloco.translate('commands.why.noperm') : null;
  });

  protected async resume(): Promise<void> {
    const why = this.why();
    if (why !== null) {
      this.toaster.show(why);
      return;
    }
    const outcome = await this.commands.resume({ slug: this.project().slug, name: this.project().name });
    if (outcome !== null) {
      this.toaster.show(outcome.verb);
    }
  }
}
