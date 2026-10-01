import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AppInfoStore } from '@console/entities/app-info';
import { connectOutcomeOf, GitHubConnectionStore } from '@console/entities/github-connection';
import {
  ProjectSetupApi,
  ProjectsStore,
  setupStepsOf,
  setupSummaryOf,
  type SetupSummary,
} from '@console/entities/project';
import { ArchiveProject } from '@console/features/archive-project';
import { GitHubConnectionCard } from '@console/features/connect-github';
import { NetworkStatus } from '@console/shared/api';
import {
  ConsoleLang,
  DEFAULT_LANG,
  isConsoleLang,
  LocalTimePipe,
  TranslocoPipe,
  TranslocoPluralPipe,
  TranslocoService,
} from '@console/shared/i18n';
import { Button, Chip, Icon, List, ListRow, StateBlock } from '@console/shared/ui';
import type { ProjectDto } from '@shared/contracts';
import { FOCUS_AFTER_ARCHIVE_STATE, readNavigationState } from './settings-navigation';

/** A row's setup chip: the Worker's status per project, loaded after the list (UX spec open question 3). */
type RowStatus = 'checking' | 'unknown' | SetupSummary;

/**
 * `/settings` (#24): the GitHub connection block, then Settings › Projects — registered projects with their setup
 * state, Add project and Archive — then the language switch and the build facts.
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
    LocalTimePipe,
    NgTemplateOutlet,
    RouterLink,
    StateBlock,
    TranslocoPipe,
    TranslocoPluralPipe,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly transloco = inject(TranslocoService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly setupApi = inject(ProjectSetupApi);
  private readonly archiver = inject(ArchiveProject);
  private readonly connection = inject(GitHubConnectionStore);

  protected readonly appInfo = inject(AppInfoStore);
  protected readonly projects = inject(ProjectsStore);
  protected readonly network = inject(NetworkStatus);

  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly addButton = viewChild('addButton', { read: ElementRef<HTMLElement> });

  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  /** The OAuth callback's `?github=` outcome, read once; the query is then dropped so a reload does not repeat it. */
  protected readonly outcome = signal(
    connectOutcomeOf(this.query().get('github'), this.query().get('login')),
  );

  protected readonly rowStatus = signal<Readonly<Record<string, RowStatus>>>({});

  private readonly activeLang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });
  protected readonly otherLang = computed<ConsoleLang>(() => {
    const current = this.activeLang();
    return isConsoleLang(current) && current === DEFAULT_LANG ? 'en' : DEFAULT_LANG;
  });

  constructor() {
    void this.projects.ready();
    // Archived from its setup page: the list applies the same focus rule as an archive from a row.
    let focusIndex = readNavigationState(this.router, FOCUS_AFTER_ARCHIVE_STATE);

    if (this.outcome() !== null) {
      void this.router.navigate([], {
        queryParams: { github: null, login: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    } else if (typeof focusIndex !== 'number') {
      afterNextRender(() => this.heading().nativeElement.focus());
    }

    // Every list load (first, retry, after an add) re-reads each row's setup status from the Worker.
    effect(() => {
      if (this.projects.status() !== 'ready') {
        return;
      }
      const slugs = this.projects.activeSlugs();
      untracked(() => {
        void this.loadRowStatus(slugs);
        if (typeof focusIndex === 'number') {
          this.focusRowAt(focusIndex);
          focusIndex = undefined;
        }
      });
    });
  }

  protected chipOf(slug: string): RowStatus {
    return this.rowStatus()[slug] ?? 'checking';
  }

  protected isSummary(status: RowStatus): status is SetupSummary {
    return typeof status === 'object';
  }

  protected open(slug: string): void {
    void this.router.navigate(['/settings/projects', slug]);
  }

  protected guardOffline(event: Event): void {
    if (!this.network.online()) {
      event.preventDefault();
    }
  }

  protected retry(): void {
    this.rowStatus.set({});
    void this.projects.load();
  }

  protected async archive(event: Event, project: ProjectDto, index: number): Promise<void> {
    // The row host listens for clicks to open the setup page; Archive sits beside its surface but inside the host.
    event.stopPropagation();
    if (!this.network.online()) {
      return;
    }
    if (await this.archiver.archive(project)) {
      this.focusRowAt(index);
    }
  }

  protected switchLang(): void {
    this.transloco.setActiveLang(this.otherLang());
  }

  /** After archiving: the next row's link, else the previous row's, else Add project (UX spec §5). */
  private focusRowAt(index: number): void {
    afterNextRender(
      () => {
        const rows = Array.from(
          this.list()?.nativeElement.querySelectorAll<HTMLElement>('.tc-list-row__surface') ?? [],
        );
        const target =
          rows[index] ?? rows[index - 1] ?? this.addButton()?.nativeElement ?? this.heading().nativeElement;
        target.focus();
      },
      { injector: this.injector },
    );
  }

  /** Statuses for rows that have none yet: an archive or an add changes the list without re-checking the rest. */
  private async loadRowStatus(slugs: readonly string[]): Promise<void> {
    const known = this.rowStatus();
    const unchecked = slugs.filter((slug) => known[slug] === undefined);
    await Promise.all(
      unchecked.map(async (slug) => {
        let status: RowStatus;
        try {
          const setup = await this.setupApi.get(slug);
          this.connection.syncFrom(setup.connection.state);
          status = setupSummaryOf(setupStepsOf(setup));
        } catch {
          // One project's status failing says nothing about the others: that row reads "Couldn't check setup".
          status = 'unknown';
        }
        this.rowStatus.update((current) => ({ ...current, [slug]: status }));
      }),
    );
  }
}
