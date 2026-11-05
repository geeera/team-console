import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AppInfoStore, DeploymentStore } from '@console/entities/app-info';
import { EnvironmentCopy, EnvironmentStatusStore, entryChipOf } from '@console/entities/environment';
import { connectOutcomeOf } from '@console/entities/github-connection';
import { GitHubConnectionCard } from '@console/features/connect-github';
import { FOCUS_PUSH_SETTINGS_STATE, PushSettingsCard } from '@console/features/push-subscribe';
import { ConsoleLang, ConsoleLanguage, TranslocoPipe } from '@console/shared/i18n';
import { Button, Chip, Icon, List, ListRow, SrOnlyOnPhone } from '@console/shared/ui';
import { readNavigationState } from './settings-navigation';

/**
 * `/settings` (#24): the GitHub connection, notifications, the language switch and the build facts. Settings holds
 * settings only (owner decision on #194): projects are listed and added on All projects.
 */
@Component({
  selector: 'tc-settings-page',
  imports: [
    Button,
    Chip,
    GitHubConnectionCard,
    Icon,
    List,
    ListRow,
    PushSettingsCard,
    SrOnlyOnPhone,
    TranslocoPipe,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly language = inject(ConsoleLanguage);
  private readonly router = inject(Router);

  protected readonly appInfo = inject(AppInfoStore);
  private readonly deployment = inject(DeploymentStore);
  private readonly environmentStatus = inject(EnvironmentStatusStore);
  /** Its `env.*` copy is a lazy chunk; when it failed, the row is a readable error with Try again instead. */
  protected readonly environmentCopy = inject(EnvironmentCopy);

  /** The Environment row (#104): the same status call as the screen it opens. */
  protected readonly entryChip = computed(() =>
    entryChipOf(this.environmentStatus.state(), this.environmentStatus.snapshot()),
  );
  protected readonly entryMissing = computed(() => {
    const chip = this.entryChip();
    return chip.kind === 'missing' ? chip.n : 0;
  });
  private readonly thisEnvironment = computed(
    () => this.environmentStatus.snapshot()?.environment ?? this.deployment.environment(),
  );
  protected readonly environmentName = computed(() => this.thisEnvironment() ?? '…');
  protected readonly environmentLink = computed(() => {
    const environment = this.thisEnvironment();
    return environment === null ? ['/settings/environment'] : ['/settings/environment', environment];
  });

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly pushHeading = viewChild.required<ElementRef<HTMLElement>>('pushHeading');

  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  /** The OAuth callback's `?github=` outcome, read once; the query is then dropped so a reload does not repeat it. */
  protected readonly outcome = signal(
    connectOutcomeOf(this.query().get('github'), this.query().get('login')),
  );

  protected readonly otherLang = computed<ConsoleLang>(() => (this.language.active() === 'ru' ? 'en' : 'ru'));

  constructor() {
    void this.deployment.ensureLoaded();
    void this.environmentStatus.ensureLoaded();
    // "How to turn on" from the Needs you nudge: the Notifications block, not the top of Settings.
    const toPush = readNavigationState(this.router, FOCUS_PUSH_SETTINGS_STATE) === true;

    if (toPush) {
      afterNextRender(() => {
        const heading = this.pushHeading().nativeElement;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
      });
    } else if (this.outcome() !== null) {
      void this.router.navigate([], {
        queryParams: { github: null, login: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    } else {
      afterNextRender(() => this.heading().nativeElement.focus());
    }
  }

  protected retryEnvironmentCopy(): void {
    void this.environmentCopy.ready();
  }

  /** The whole interface follows at once, and the choice is remembered on this device (#4, #125). */
  protected switchLang(): void {
    void this.language.use(this.otherLang());
  }
}
