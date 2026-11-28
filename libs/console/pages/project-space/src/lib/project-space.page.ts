import { Dialog } from '@angular/cdk/dialog';
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
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  isOnConsoleTracker,
  isSpaceSection,
  ProjectsStore,
  spaceLocationOf,
  SpaceSection,
  VISIBLE_SPACE_SECTIONS,
} from '@console/entities/project';
import { TeamStatusStore } from '@console/entities/team-run';
import { NewTaskButton } from '@console/features/create-task';
import { InstallCard } from '@console/features/install-app';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import {
  Button,
  focusAfterRender,
  Icon,
  IconButton,
  IconName,
  isPhoneSignal,
  Sheet,
  Tab,
  TabBar,
  TopBarAction,
} from '@console/shared/ui';
import {
  CommandsPane,
  CommandsSheet,
  isCommandsShortcut,
  PausedBanner,
  type CommandsProject,
} from '@console/widgets/commands-panel';
import { filter, map } from 'rxjs';
import { SpacePane } from './space-pane';

function isTyping(target: Element | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

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
    IconButton,
    InstallCard,
    NewTaskButton,
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
  providers: [SpacePane],
  host: {
    class: 'tc-space m-route-skip',
    '[class.tc-space--phone]': 'isPhone()',
    '[class.tc-space--pane]': 'isPaneOpen()',
    '[class.tc-space--cards]': 'hasCardGrid()',
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class ProjectSpacePage {
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsStore);
  private readonly sheet = inject(Sheet);
  private readonly dialog = inject(Dialog);
  private readonly transloco = inject(TranslocoService);
  private readonly teamStatus = inject(TeamStatusStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Bound from the route by `withComponentInputBinding()`. */
  readonly slug = input.required<string>();

  protected readonly sections = VISIBLE_SPACE_SECTIONS.map((section) => ({
    section,
    icon: SECTION_ICONS[section],
  }));
  protected readonly project = computed(() => this.projects.bySlug(this.slug()));
  protected readonly commandsProject = computed<CommandsProject>(() => {
    const project = this.project();
    return { slug: this.slug(), name: project?.displayName ?? this.slug(), repo: project?.repo ?? '' };
  });
  /** Find a task (#435) is for projects on the console tracker; a GitHub project's tasks are on GitHub. */
  protected readonly canFind = computed(() => isOnConsoleTracker(this.project()));
  /** The Commands pane on a wide screen; the phone opens a sheet instead. */
  protected readonly isPaneOpen = inject(SpacePane).isOpen;
  protected readonly isPhone = isPhoneSignal();

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
    // The heading is keyed on the slug (#506), so a switch replaces the node; a focused heading would drop focus to
    // <body>. Read before the template refreshes, refocus the new node after it renders — only when the old one
    // held focus, so a switch never steals focus from something else the owner was using (#964).
    effect(() => {
      this.slug();
      const title = untracked(() => this.query('.space__title'));
      if (title !== null && title === document.activeElement) {
        untracked(() => afterNextRender(() => this.query('.space__title')?.focus(), { injector: this.injector }));
      }
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

  /** The install card went away by the owner's choice: keyboard users continue from the space's heading. */
  protected focusHeading(): void {
    this.query('.space__title')?.focus();
  }

  /** The paused banner left with its Resume button: its Commands button is the next stop, visible on every width. */
  protected focusCommandsButton(): void {
    // On the phone the button sits in the shell's top bar, outside this page's host.
    focusAfterRender(
      () => {
        const button = document.querySelector<HTMLElement>('[data-testid="commands-open"]');
        return button === null ? null : new ElementRef(button);
      },
      { injector: this.injector, onlyIfFocusLost: true },
    );
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
    // `/` opens Find (#409 §1), unless the owner is typing.
    if (event.key === '/' && this.canFind() && !isTyping(target) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      this.openFind();
      return;
    }
    if (isCommandsShortcut(event)) {
      event.preventDefault();
      this.toggleCommands();
    }
  }

  protected openFind(): void {
    void this.router.navigate(['/p', this.slug(), 'find']);
  }

  private query(selector: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(selector);
  }

  protected readonly currentSection = computed<SpaceSection | null>(() => {
    const first = spaceLocationOf(this.url())?.path.split(/[/?#]/, 1)[0];
    // A task (`t/:n`, #435) belongs to the board: its tab stays current and the body keeps the board's width.
    if (first === 't' || first === 'find') {
      return 'board';
    }
    return isSpaceSection(first) ? first : null;
  });

  /** Sections that list decision cards get the wider body, two cards side by side on a Mac (#276). */
  protected readonly hasCardGrid = computed(() => {
    const section = this.currentSection();
    return section === 'questions' || section === 'demo';
  });
}
