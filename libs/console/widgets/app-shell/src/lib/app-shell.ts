import { BreakpointObserver } from '@angular/cdk/layout';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
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
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { ADD_PROJECT_URL, NeedsYouCounts, ProjectsStore, spaceLocationOf } from '@console/entities/project';
import { ProjectSwitcher } from '@console/features/project-switcher';
import { LocalNumberPipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore, scrollKeyOf } from '@console/shared/persisted-state';
import { AppBadge } from '@console/shared/platform';
import { EnvironmentMark } from '@console/entities/app-info';
import {
  BREAKPOINTS,
  Button,
  Chip,
  Icon,
  IconButton,
  isPageScrollLocked,
  List,
  ListRow,
  StateBlock,
  ToastOutlet,
  TopBar,
  TopBarActions,
} from '@console/shared/ui';
import { filter, map } from 'rxjs';
import { restoreScroll, type ScrollRestore } from './scroll-restore';
import { shellAreaOf } from './shell-location';

/**
 * The frame around every screen: the Paper Desk sidebar on wide screens (pinned beside the page), a sticky top bar
 * that opens the projects sheet on the phone, and `<main>`. Only the document scrolls (#274): no scroll inside a
 * scroll, and on the iPhone a tap on the status bar takes the page to the top. The shell owns scroll persistence:
 * it records the document's position per project screen and restores it after each navigation.
 */
@Component({
  selector: 'tc-app-shell',
  imports: [
    Button,
    Chip,
    EnvironmentMark,
    Icon,
    IconButton,
    List,
    ListRow,
    LocalNumberPipe,
    NgTemplateOutlet,
    ProjectSwitcher,
    RouterLink,
    RouterOutlet,
    StateBlock,
    ToastOutlet,
    TopBar,
    TranslocoPipe,
  ],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-app-shell',
    '[class.tc-app-shell--sidebar]': 'hasSidebar()',
    '(window:scroll)': 'onScroll()',
  },
})
export class AppShell {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly transloco = inject(TranslocoService);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly state = inject(PersistedStateStore);
  private readonly badge = inject(AppBadge);

  protected readonly projects = inject(ProjectsStore);
  protected readonly needsYou = inject(NeedsYouCounts);
  /** The current screen's own action in the phone's top bar (#114: Commands in a project space). */
  protected readonly screenAction = inject(TopBarActions).template;

  private readonly document = inject(DOCUMENT);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private scrollFrame: number | null = null;
  private scrollRestore: ScrollRestore | null = null;
  private openingProjects = false;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly hasSidebar = toSignal(
    this.breakpoints.observe(BREAKPOINTS.tablet).pipe(map((result) => !result.matches)),
    { initialValue: !this.breakpoints.isMatched(BREAKPOINTS.tablet) },
  );

  protected readonly area = computed(() => shellAreaOf(this.url()));
  /** The sidebar's Add project: All projects at its GitHub section (#194). */
  protected readonly addProjectUrl = ADD_PROJECT_URL;
  protected readonly space = computed(() => spaceLocationOf(this.url()));
  protected readonly currentProject = computed(() => {
    const slug = this.space()?.slug;
    return slug === undefined ? undefined : this.projects.bySlug(slug);
  });

  /** What the phone top bar says: the project, the cross-project screen, or the app. */
  protected readonly titleKey = computed(() => {
    switch (this.area()) {
      case 'needs-you':
        return 'shell.needsYou';
      case 'overview':
        return 'shell.overview';
      case 'settings':
        return 'shell.settings';
      default:
        return 'app.name';
    }
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Cross-project routes have no guard that awaits the list; the sidebar needs it either way.
    void this.projects.ready();
    destroyRef.onDestroy(this.needsYou.start());
    // The app icon's number is Needs you (#36): set after each refresh (on open, on return to the front, each
    // minute while visible) and cleared at 0. A push itself cannot change it in v1 (ADR 0001, "Not yet").
    effect(() => {
      if (this.needsYou.refreshedAt() === null) {
        return;
      }
      const total = this.needsYou.total();
      void this.badge.set(total);
    });

    const navigations = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.onNavigated(event.urlAfterRedirects));
    destroyRef.onDestroy(() => {
      navigations.unsubscribe();
      this.scrollRestore?.cancel();
    });
    // The shell may be created after the first navigation already ended (tests, a late mount).
    if (this.router.navigated) {
      this.onNavigated(this.router.url);
    }
  }

  /**
   * The sheet, and the CDK dialog under it, load on the first tap rather than with the app (#123: the initial bundle);
   * the service worker has the chunk on the device already. A second tap while it loads opens nothing more.
   */
  protected async openProjects(): Promise<void> {
    if (this.openingProjects) {
      return;
    }
    this.openingProjects = true;
    try {
      const { openProjectsSheet } = await import('./projects-sheet');
      openProjectsSheet(this.injector, this.transloco.translate('shell.projects'));
    } finally {
      this.openingProjects = false;
    }
  }

  /** Rows are buttons (a RouterLink on the row host would add a second tab stop); the phone's Settings icon stays a link. */
  protected async go(url: string): Promise<void> {
    await this.router.navigateByUrl(url);
  }

  protected retry(): void {
    void this.projects.load();
  }

  protected onScroll(): void {
    // One store write per frame at most; the store debounces the storage write on top of that.
    if (this.scrollFrame !== null) {
      return;
    }
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      const location = this.space();
      // While a restore waits for the content, scroll events are the browser clamping, not a new position; while a
      // sheet is open they are the lock pinning the page.
      if (
        location !== null &&
        this.scrollRestore?.isPending() !== true &&
        !isPageScrollLocked(this.document)
      ) {
        this.state.setScroll(location.slug, scrollKeyOf(location.path), this.scroller().scrollTop);
      }
    });
  }

  private onNavigated(url: string): void {
    const location = spaceLocationOf(url);
    let top = 0;
    if (location !== null && this.projects.isActive(location.slug)) {
      this.state.setActiveSlug(location.slug);
      this.state.setLastPath(location.slug, location.path);
      top = this.state.scrollOf(location.slug, scrollKeyOf(location.path));
    }
    this.scrollRestore?.cancel();
    // A screen opened with a fragment (a tapped notification's `#n`, #36) brings its own target into view;
    // restoring the saved position would scroll it away again.
    if (url.includes('#')) {
      this.scrollRestore = null;
      return;
    }
    // The new screen is in the DOM only after the next render; the router's own restoration is off.
    afterNextRender(
      () => (this.scrollRestore = restoreScroll(this.scroller(), this.main().nativeElement, top)),
      { injector: this.injector },
    );
  }

  private scroller(): Element {
    return this.document.scrollingElement ?? this.document.documentElement;
  }
}
