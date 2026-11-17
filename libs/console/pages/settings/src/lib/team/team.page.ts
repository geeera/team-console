import { ChangeDetectionStrategy, Component, computed, inject, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import { TeamConfigEditor } from '@console/features/team-config';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '@console/shared/ui';

/**
 * `/settings/projects/:slug/team` (#688): Settings › project › Team, in the sub-page frame of Settings › Runners and
 * its own lazy chunk. The page is the frame and the way back; the editor owns the form, its states and its save.
 */
@Component({
  selector: 'tc-team-page',
  imports: [Icon, RouterLink, TeamConfigEditor, TranslocoPipe],
  template: `
    <div class="tc-page subpage team-page">
      <nav class="subpage__crumbs" [attr.aria-label]="'settings.breadcrumb' | transloco">
        <a [routerLink]="['/settings/projects', slug()]" data-testid="team-back">
          <tc-icon name="chevron-left" size="sm" />{{ projectName() }}
        </a>
      </nav>
      <tc-team-config-editor [slug]="slug()" [projectName]="projectName()" [focus]="focus() ?? null" />
    </div>
  `,
  styleUrls: ['../settings-subpage.css'],
  styles: `
    .team-page {
      padding-bottom: var(--space-8);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamPage {
  private readonly projects = inject(ProjectsStore);
  private readonly editor = viewChild(TeamConfigEditor);

  /** The route's `:slug`, bound by the router (`withComponentInputBinding`). */
  readonly slug = input.required<string>();
  /** `?focus=budget` from the Needs-you "Open limits" link (#688), bound by the router like the slug. */
  readonly focus = input<string | undefined>(undefined);

  protected readonly projectName = computed(
    () => this.projects.bySlug(this.slug())?.displayName ?? this.slug(),
  );

  constructor() {
    void this.projects.ready();
  }

  /** Unsaved edits ask "Leave without saving?" first. */
  canLeave(): Promise<boolean> {
    return this.editor()?.confirmLeave() ?? Promise.resolve(true);
  }
}
