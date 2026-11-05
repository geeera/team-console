import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
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
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { EnvironmentCopy } from '@console/entities/environment';
import { ProjectsStore } from '@console/entities/project';
import { NetworkStatus } from '@console/shared/api';
import {
  LocalTimePipe,
  TranslocoPipe,
  TranslocoPluralPipe,
  TranslocoService,
  pluralKeyOf,
} from '@console/shared/i18n';
import { Button, CopyCode, Icon, StateBlock, TabPanel, Tabs } from '@console/shared/ui';
import { ENVIRONMENTS, type Environment } from '@shared/contracts';
import { setupCommandOf } from '@shared/environment';
import { EnvironmentRow } from './environment-row';
import { EnvironmentScreen } from './environment-screen';

/**
 * `/settings/environment/:env` (#104): the tabs, the summary with the one fix command, and every manifest item of
 * the selected environment grouped by where it lives. A row opens its guide in the outlet: its own page on a narrow
 * screen, a pane beside the list on a wide one. Values are never shown — the screen only knows set, missing or not
 * visible here.
 */
@Component({
  selector: 'tc-environment-setup-page',
  imports: [
    Button,
    CopyCode,
    EnvironmentRow,
    Icon,
    LocalTimePipe,
    NgTemplateOutlet,
    RouterLink,
    RouterOutlet,
    StateBlock,
    TabPanel,
    Tabs,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  providers: [EnvironmentScreen],
  templateUrl: './environment-setup.page.html',
  styleUrls: ['../settings-subpage.css', './environment-setup.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'closeGuide()' },
})
export class EnvironmentSetupPage {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);

  protected readonly screen = inject(EnvironmentScreen);
  protected readonly projects = inject(ProjectsStore);
  protected readonly network = inject(NetworkStatus);
  protected readonly status = this.screen.status;
  /** The `env.*` copy chunk; when it could not load, the page is a readable error with Try again. */
  protected readonly copy = inject(EnvironmentCopy);

  /** The route's `:env`, already checked by the route guard. */
  readonly env = input.required<Environment>();

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly summaryHeading = viewChild<ElementRef<HTMLElement>>('summaryHeading');

  /** The tab order of the design: the deployed environments, then the owner's computer. */
  protected readonly environments: readonly Environment[] = ['dev', 'stage', 'production', 'local'];
  protected readonly view = this.screen.view;
  protected readonly thisEnvironment = this.screen.thisEnvironment;
  protected readonly isThisTab = computed(() => this.view().isThisConsole);
  protected readonly checking = computed(() => this.status.state() === 'loading');
  protected readonly problem = this.status.problem;
  protected readonly forbidden = computed(() => this.problem()?.kind === 'forbidden');
  protected readonly hasAnswer = computed(() => this.status.snapshot() !== null);
  protected readonly rateUntil = computed(() => {
    const problem = this.problem();
    return problem?.kind === 'rate' ? problem.retryAt : null;
  });
  /** Why Check again is off, if it is (UX spec: `aria-disabled` with the reason, never `disabled`). */
  protected readonly recheckOff = computed(
    () => this.checking() || !this.network.online() || this.rateUntil() !== null,
  );
  protected readonly setCommand = computed(() => setupCommandOf(this.env()));
  protected readonly checkCommand = computed(() => setupCommandOf(this.env(), 'check'));
  /** Project blocks the owner opened or closed by hand; the rest follow "open while something is missing". */
  private readonly toggled = signal<ReadonlyMap<string, boolean>>(new Map());

  constructor() {
    effect(() => {
      const env = this.env();
      untracked(() => this.screen.environment.set(env));
    });
    afterNextRender(() => {
      if (this.screen.openId() === null) {
        this.heading().nativeElement.focus();
      }
    });
    // Back from a guide: focus returns to the row that opened it (UX spec §5).
    effect(() => {
      const open = this.screen.openId();
      const last = untracked(() => this.screen.lastOpenedId());
      if (open === null && last !== null) {
        // After the render that shows the list again: a hidden row cannot take focus on a narrow page.
        afterNextRender(() => this.focusRow(last), { injector: this.injector });
      }
    });
  }

  protected isProjectOpen(slug: string, hasMissing: boolean): boolean {
    return this.toggled().get(slug) ?? hasMissing;
  }

  protected toggleProject(slug: string, hasMissing: boolean): void {
    const next = new Map(this.toggled());
    next.set(slug, !this.isProjectOpen(slug, hasMissing));
    this.toggled.set(next);
  }

  protected selectTab(key: string | null): void {
    const env = ENVIRONMENTS.find((candidate) => candidate === key);
    if (env === undefined || env === this.env()) {
      return;
    }
    void this.router.navigate(['/settings/environment', env], { replaceUrl: true });
    afterNextRender(() => void this.announceSummary(), { injector: this.injector });
  }

  /** "Go to the first missing one": that row's link, its project block opened first. */
  protected jumpToFirstMissing(event: Event): void {
    event.preventDefault();
    const first = this.view().firstMissing;
    if (first === null) {
      return;
    }
    if (first.row.project !== null) {
      const next = new Map(this.toggled());
      next.set(first.row.project, true);
      this.toggled.set(next);
    }
    afterNextRender(() => this.focusRow(first.row.id), { injector: this.injector });
  }

  protected async recheck(): Promise<void> {
    if (this.recheckOff()) {
      return;
    }
    const hadAnswer = this.hasAnswer();
    await this.status.load();
    if (this.status.state() === 'ready') {
      if (!hadAnswer) {
        afterNextRender(() => this.summaryHeading()?.nativeElement.focus(), { injector: this.injector });
      }
      await this.announceSummary();
    }
  }

  protected async retryCopy(): Promise<void> {
    const hadFailed = this.copy.failed();
    if (await this.copy.ready()) {
      afterNextRender(() => this.heading().nativeElement.focus(), { injector: this.injector });
      return;
    }
    // A failed dynamic import() stays failed for the page's lifetime in a real browser: this Try again click
    // already saw a prior failure (the route guard's own load), so a second one can't recover in place — a full
    // reload is the only way back.
    if (hadFailed) {
      this.document.location.reload();
    }
  }

  protected retryProjects(): void {
    void this.projects.load();
  }

  protected closeGuide(): void {
    if (this.screen.openId() !== null) {
      void this.router.navigate(['/settings/environment', this.env()]);
    }
  }

  private focusRow(id: string): void {
    const link = this.host.nativeElement.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    link?.focus();
  }

  private async announceSummary(): Promise<void> {
    await this.announcer.announce(this.summaryText(), 'polite');
  }

  /** The summary's heading line, as the tab switch and Check again announce it (UX spec §5). */
  private summaryText(): string {
    const view = this.view();
    const env = view.environment;
    const current = this.thisEnvironment();
    if (!view.isThisConsole) {
      if (env === 'local') {
        return this.transloco.translate('env.sum.local');
      }
      return current === null
        ? this.transloco.translate('env.sum.otherUnknown', { env })
        : this.transloco.translate('env.sum.other', { this: current, env });
    }
    return view.missing > 0
      ? this.transloco.translate(
          pluralKeyOf('env.sum.missing', this.transloco.getActiveLang(), view.missing),
          {
            n: view.missing,
            env,
          },
        )
      : this.transloco.translate('env.sum.ok', { env });
  }
}
