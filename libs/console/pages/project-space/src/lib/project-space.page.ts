import { Dialog } from '@angular/cdk/dialog';
import { BreakpointObserver } from '@angular/cdk/layout';
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
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  isSpaceSection,
  ProjectsStore,
  spaceLocationOf,
  SpaceSection,
  VISIBLE_SPACE_SECTIONS,
} from '@console/entities/project';
import { TeamStatusStore } from '@console/entities/team-run';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { BREAKPOINTS, Button, Icon, IconName, Sheet, Tab, TabBar, TopBarAction } from '@console/shared/ui';
import {
  CommandsPane,
  CommandsSheet,
  isCommandsShortcut,
  PausedBanner,
  type CommandsProject,
} from '@console/widgets/commands-panel';
import { filter, map } from 'rxjs';

const SECTION_ICONS: Record<SpaceSection, IconName> = {
  questions: 'inbox',
  chat: 'chat',
  board: 'board',
  artifacts: 'stack',
  demo: 'play',
};

/**
 * `/p/:slug`: the project's name, the section tabs (a bottom bar on the phone) and the outlet the
 * sections render into. Only reachable for an active slug — the route's `canMatch` guard sees to that.
 * Commands (#114): a pane on the right on wide screens (K toggles it, the section stays usable), a bottom sheet on
 * the phone; while the team is paused, a banner with Resume above the section.
 */
@Component({
  selector: 'tc-project-space-page',
  imports: [
    Button,
    CommandsPane,
    Icon,
    PausedBanner,
    RouterLink,
    RouterOutlet,
    Tab,
    TabBar,
    TopBarAction,
    TranslocoPipe,
  ],
  templateUrl: './project-space.page.html',
  styleUrl: './project-space.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'tc-space',
    '[class.tc-space--phone]': 'isPhone()',
    '[class.tc-space--pane]': 'isPaneOpen()',
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class ProjectSpacePage {
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsStore);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly sheet = inject(Sheet);
  private readonly dialog = inject(Dialog);
  private readonly transloco = inject(TranslocoService);
  private readonly teamStatus = inject(TeamStatusStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Bound from the route by `withComponentInputBinding()`. */
  readonly slug = input.required<string>();

  protected readonly sections = VISIBLE_SPACE_SECTIONS.map((section) => ({ section, icon: SECTION_ICONS[section] }));
  protected readonly project = computed(() => this.projects.bySlug(this.slug()));
  protected readonly commandsProject = computed<CommandsProject>(() => {
    const project = this.project();
    return { slug: this.slug(), name: project?.displayName ?? this.slug(), repo: project?.repo ?? '' };
  });
  /** The Commands pane on a wide screen; the phone opens a sheet instead. */
  protected readonly isPaneOpen = signal(false);
  protected readonly isPhone = toSignal(
    this.breakpoints.observe(BREAKPOINTS.phone).pipe(map((result) => result.matches)),
    { initialValue: this.breakpoints.isMatched(BREAKPOINTS.phone) },
  );

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  constructor() {
    // The banner needs the team's state as soon as the space opens; the panel reads it again when opened.
    effect(() => {
      const slug = this.slug();
      untracked(() => void this.teamStatus.load(slug));
    });
    effect(() => {
      if (this.isPhone()) {
        untracked(() => this.isPaneOpen.set(false));
      }
    });
  }

  protected toggleCommands(): void {
    if (this.isPhone()) {
      void this.teamStatus.refresh();
      this.sheet.open(CommandsSheet, {
        title: this.transloco.translate('commands.title', { name: this.commandsProject().name }),
        data: this.commandsProject(),
      });
      return;
    }
    if (this.isPaneOpen()) {
      this.closePane();
      return;
    }
    void this.teamStatus.refresh();
    this.isPaneOpen.set(true);
    afterNextRender(() => this.query('.cp__title')?.focus(), { injector: this.injector });
  }

  protected closePane(): void {
    this.isPaneOpen.set(false);
    afterNextRender(() => this.query('[data-testid="commands-open"]')?.focus(), { injector: this.injector });
  }

  /** K toggles the pane (bare letter, also on the Russian layout); Escape closes it from inside. */
  protected onKeydown(event: KeyboardEvent): void {
    if (this.isPhone() || this.dialog.openDialogs.length > 0 || event.defaultPrevented) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === 'Escape' && this.isPaneOpen() && target?.closest('.tc-commands-pane')) {
      event.preventDefault();
      this.closePane();
      return;
    }
    if (isCommandsShortcut(event)) {
      event.preventDefault();
      this.toggleCommands();
    }
  }

  private query(selector: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(selector);
  }

  protected readonly currentSection = computed<SpaceSection | null>(() => {
    const first = spaceLocationOf(this.url())?.path.split(/[/?#]/, 1)[0];
    return isSpaceSection(first) ? first : null;
  });
}
