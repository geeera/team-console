import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { NeedsYouCounts, ProjectsStore, spaceLocationOf, spaceUrlOf } from '@console/entities/project';
import { LocalNumberPipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore } from '@console/shared/persisted-state';
import { Chip, Icon, IconButton, List, ListRow } from '@console/shared/ui';
import { isSnoozeActive, ProjectDto } from '@shared/contracts';
import { filter, map } from 'rxjs';

let nextSwitcherId = 0;
/** A snooze that ends while the sidebar is open loses its bell within this. */
const SNOOZE_TICK_MS = 60_000;

/**
 * The project list of the sidebar and of the phone sheet: pinned projects first (in pin order),
 * the rest sorted by name behind a disclosure once anything is pinned. Choosing a project opens
 * its last screen; the badge is that project's open "needs you" count.
 */
@Component({
  selector: 'tc-project-switcher',
  imports: [Chip, Icon, IconButton, List, ListRow, LocalNumberPipe, TranslocoPipe],
  templateUrl: './project-switcher.html',
  styleUrl: './project-switcher.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectSwitcher {
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly projects = inject(ProjectsStore);
  private readonly state = inject(PersistedStateStore);
  private readonly needsYou = inject(NeedsYouCounts);

  private readonly now = signal(Date.now());

  /** Fires after the navigation to the chosen project starts, so a sheet can close. */
  readonly switched = output<string>();

  private readonly id = `tc-switcher-${nextSwitcherId++}`;
  protected readonly pinnedLabelId = `${this.id}-pinned`;
  protected readonly othersLabelId = `${this.id}-others`;
  protected readonly othersId = `${this.id}-others-list`;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  private readonly lang = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly currentSlug = computed(() => spaceLocationOf(this.url())?.slug ?? null);
  protected readonly collapsed = this.state.collapsed;

  protected readonly pinnedProjects = computed<readonly ProjectDto[]>(() => {
    const active = this.projects.active();
    return this.state
      .pinned()
      .map((slug) => active.find((project) => project.slug === slug))
      .filter((project): project is ProjectDto => project !== undefined);
  });

  protected readonly otherProjects = computed<readonly ProjectDto[]>(() => {
    const pinned = new Set(this.state.pinned());
    const collator = new Intl.Collator(this.lang());
    return this.projects
      .active()
      .filter((project) => !pinned.has(project.slug))
      .sort((a, b) => collator.compare(a.displayName, b.displayName));
  });

  /** The rest folds only once something is pinned; otherwise folding would empty the list. */
  protected readonly hasDisclosure = computed(
    () => this.pinnedProjects().length > 0 && this.otherProjects().length > 0,
  );
  protected readonly othersVisible = computed(() => !this.hasDisclosure() || !this.collapsed());

  /** Projects whose notifications are snoozed right now (#221): the bell with the slash, and the words. */
  protected readonly snoozedSlugs = computed(() => {
    const nowMs = this.now();
    return new Set(
      this.projects
        .active()
        .filter((project) => isSnoozeActive(project.snooze, nowMs))
        .map((project) => project.slug),
    );
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), SNOOZE_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected countOf(slug: string): number {
    return this.needsYou.countOf(slug);
  }

  protected isPinned(slug: string): boolean {
    return this.state.isPinned(slug);
  }

  protected async switchTo(slug: string): Promise<void> {
    this.state.setActiveSlug(slug);
    const navigation = this.router.navigateByUrl(spaceUrlOf(slug, this.state.projectState(slug)?.lastPath));
    this.switched.emit(slug);
    await navigation;
  }

  protected togglePin(event: Event, slug: string): void {
    // The action sits beside the row's button, but the click still bubbles through the row host.
    event.stopPropagation();
    this.state.togglePin(slug);
  }

  protected toggleCollapsed(): void {
    this.state.setCollapsed(!this.state.collapsed());
  }
}
