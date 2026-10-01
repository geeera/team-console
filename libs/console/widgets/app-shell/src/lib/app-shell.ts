import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { NeedsYouCounts, ProjectsStore, spaceLocationOf } from '@console/entities/project';
import { ProjectSwitcher } from '@console/features/project-switcher';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { PersistedStateStore, scrollKeyOf } from '@console/shared/persisted-state';
import {
  BREAKPOINTS,
  Button,
  Chip,
  Icon,
  IconButton,
  List,
  ListRow,
  Sheet,
  StateBlock,
  ToastOutlet,
  TopBar,
  TopBarActions,
} from '@console/shared/ui';
import { filter, map } from 'rxjs';
import { ProjectsSheet } from './projects-sheet';
import { restoreScroll, type ScrollRestore } from './scroll-restore';
import { shellAreaOf } from './shell-location';

/**
 * The frame around every screen: the Paper Desk sidebar on wide screens, a top bar that opens the
 * projects sheet on the phone, and the one scrolling `<main>`. The shell owns scroll persistence:
 * it records `<main>`'s position per project screen and restores it after each navigation.
 */
@Component({
  selector: 'tc-app-shell',
  imports: [
    Button,
    Chip,
    Icon,
    IconButton,
    List,
    ListRow,
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
  host: { class: 'tc-app-shell', '[class.tc-app-shell--sidebar]': 'hasSidebar()' },
})
export class AppShell {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly sheet = inject(Sheet);
  private readonly transloco = inject(TranslocoService);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly state = inject(PersistedStateStore);

  protected readonly projects = inject(ProjectsStore);
  protected readonly needsYou = inject(NeedsYouCounts);
  /** The current screen's own action in the phone's top bar (#114: Commands in a project space). */
  protected readonly screenAction = inject(TopBarActions).template;

  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private scrollFrame: number | null = null;
  private scrollRestore: ScrollRestore | null = null;

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

  protected openProjects(): void {
    this.sheet.open(ProjectsSheet, { title: this.transloco.translate('shell.projects') });
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
      // While a restore waits for the content, scroll events are the browser clamping, not a new position.
      if (location !== null && this.scrollRestore?.isPending() !== true) {
        this.state.setScroll(location.slug, scrollKeyOf(location.path), this.main().nativeElement.scrollTop);
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
    // The new screen is in the DOM only after the next render; the router's own restoration is off.
    afterNextRender(() => (this.scrollRestore = restoreScroll(this.main().nativeElement, top)), {
      injector: this.injector,
    });
  }
}
