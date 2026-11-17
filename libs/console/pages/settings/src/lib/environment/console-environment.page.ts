import { LiveAnnouncer } from '@angular/cdk/a11y';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { EnvironmentCopy, type RowView } from '@console/entities/environment';
import { ConsoleLanguage, pluralKeyOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, StateBlock, TabPanel, Tabs } from '@console/shared/ui';
import { ENVIRONMENTS, type Environment } from '@shared/contracts';
import { EnvironmentRow } from './environment-row';
import { ConsoleEnvironmentScreen, EnvironmentScreen } from './environment-screen';
import { EnvironmentSummary } from './environment-summary';

/**
 * `/admin/environment/:env` (#104, moved out of Settings by #750): the operator's screen of this console's own
 * secrets and variables — the tabs, the summary with the one fix command, and every manifest item of the selected
 * environment grouped by where it lives, per-project rows aside (they are on each project's screen). A row opens its
 * guide in the outlet: its own page on a narrow screen, a pane beside the list on a wide one. Values are never
 * shown — the screen only knows set, missing or not visible here.
 */
@Component({
  selector: 'tc-console-environment-page',
  imports: [
    Button,
    EnvironmentRow,
    EnvironmentSummary,
    Icon,
    RouterLink,
    RouterOutlet,
    StateBlock,
    TabPanel,
    Tabs,
    TranslocoPipe,
  ],
  providers: [
    ConsoleEnvironmentScreen,
    { provide: EnvironmentScreen, useExisting: ConsoleEnvironmentScreen },
  ],
  templateUrl: './console-environment.page.html',
  styleUrls: ['../settings-subpage.css', './environment-layout.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'closeGuide()' },
})
export class ConsoleEnvironmentPage {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  /** Try again resolves after an await: the page may be gone by then, and a render hook on it would throw (NG0205). */
  private isDestroyed = false;
  private readonly announcer = inject(LiveAnnouncer);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  /** The summary's lines are computed, so they follow a language switch through this signal. */
  private readonly language = inject(ConsoleLanguage);

  protected readonly screen = inject(ConsoleEnvironmentScreen);
  protected readonly status = this.screen.status;
  /** The `env.*` copy chunk; when it could not load, the page is a readable error with Try again. */
  protected readonly copy = inject(EnvironmentCopy);

  /** The route's `:env`, already checked by the route guard. */
  readonly env = input.required<Environment>();

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  /** The tab order of the design: the deployed environments, then the owner's computer. */
  protected readonly environments: readonly Environment[] = ['dev', 'stage', 'production', 'local'];
  protected readonly view = this.screen.view;
  protected readonly thisEnvironment = this.screen.thisEnvironment;
  protected readonly checking = computed(() => this.status().state() === 'loading');
  protected readonly forbidden = computed(() => this.status().problem()?.kind === 'forbidden');
  /** The summary's heading as it reads now; Check again and a tab switch announce it (UX spec §5). */
  protected readonly summaryTitle = computed(() => {
    this.language.active();
    const view = this.view();
    return view.missing > 0
      ? this.translatePlural('env.sum.missing', view.missing, { env: view.environment })
      : this.transloco.translate('env.sum.ok', { env: view.environment });
  });
  protected readonly otherLine = computed(() => {
    this.language.active();
    const env = this.env();
    const current = this.thisEnvironment();
    if (env === 'local') {
      return this.transloco.translate('env.sum.local');
    }
    return current === null
      ? this.transloco.translate('env.sum.otherUnknown', { env })
      : this.transloco.translate('env.sum.other', { this: current, env });
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.isDestroyed = true));
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

  protected linkOf(view: RowView): readonly string[] {
    return this.screen.guideRouteOf(this.env(), view);
  }

  protected selectTab(key: string | null): void {
    const env = ENVIRONMENTS.find((candidate) => candidate === key);
    if (env === undefined || env === this.env()) {
      return;
    }
    void this.router.navigate(this.screen.listRouteOf(env), { replaceUrl: true });
    afterNextRender(() => void this.announceSummary(), { injector: this.injector });
  }

  /** "Go to the first missing one": that row's link. */
  protected jumpToFirstMissing(): void {
    const first = this.view().firstMissing;
    if (first !== null) {
      this.focusRow(first.row.id);
    }
  }

  protected async retryCopy(): Promise<void> {
    const hadFailed = this.copy.failed();
    const isReady = await this.copy.ready();
    if (this.isDestroyed) {
      return;
    }
    if (isReady) {
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

  protected closeGuide(): void {
    if (this.screen.openId() !== null) {
      void this.router.navigate(this.screen.listRouteOf(this.env()));
    }
  }

  private focusRow(id: string): void {
    const link = this.host.nativeElement.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    link?.focus();
  }

  private async announceSummary(): Promise<void> {
    await this.announcer.announce(
      this.view().isThisConsole ? this.summaryTitle() : this.otherLine(),
      'polite',
    );
  }

  private translatePlural(key: string, n: number, params: Record<string, unknown>): string {
    return this.transloco.translate(pluralKeyOf(key, this.language.active(), n), { ...params, n });
  }
}
