import { BreakpointObserver } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  isSpaceSection,
  ProjectsStore,
  SPACE_SECTIONS,
  spaceLocationOf,
  SpaceSection,
} from '@console/entities/project';
import { TranslocoPipe } from '@console/shared/i18n';
import { BREAKPOINTS, Icon, IconName, Tab, TabBar } from '@console/shared/ui';
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
 */
@Component({
  selector: 'tc-project-space-page',
  imports: [Icon, RouterLink, RouterOutlet, Tab, TabBar, TranslocoPipe],
  templateUrl: './project-space.page.html',
  styleUrl: './project-space.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'tc-space', '[class.tc-space--phone]': 'isPhone()' },
})
export class ProjectSpacePage {
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsStore);
  private readonly breakpoints = inject(BreakpointObserver);

  /** Bound from the route by `withComponentInputBinding()`. */
  readonly slug = input.required<string>();

  protected readonly sections = SPACE_SECTIONS.map((section) => ({ section, icon: SECTION_ICONS[section] }));
  protected readonly project = computed(() => this.projects.bySlug(this.slug()));
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

  protected readonly currentSection = computed<SpaceSection | null>(() => {
    const first = spaceLocationOf(this.url())?.path.split(/[/?#]/, 1)[0];
    return isSpaceSection(first) ? first : null;
  });
}
