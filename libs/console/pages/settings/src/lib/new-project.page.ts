import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AddProjectForm } from '@console/features/add-project';
import { TranslocoPipe } from '@console/shared/i18n';
import { Icon } from '@console/shared/ui';

/** `/settings/projects/new` (#24): the shell's "Add project" entry points land here. */
@Component({
  selector: 'tc-new-project-page',
  imports: [AddProjectForm, Icon, RouterLink, TranslocoPipe],
  template: `
    <div class="tc-page subpage">
      <nav class="subpage__crumbs" [attr.aria-label]="'settings.breadcrumb' | transloco">
        <a routerLink="/settings"
          ><tc-icon name="chevron-left" size="sm" />{{ 'settings.title' | transloco }}</a
        >
      </nav>
      <h1 class="tc-page__title subpage__title" tabindex="-1">{{ 'settings.add.title' | transloco }}</h1>
      <tc-add-project-form />
    </div>
  `,
  styleUrl: './settings-subpage.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewProjectPage {}
