import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { EnvironmentCopy, type ProjectSectionView, type RowView } from '@console/entities/environment';
import { projectSetupRouteOf, ProjectsStore } from '@console/entities/project';
import { ConsoleLanguage, pluralKeyOf, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Icon, StateBlock } from '@console/shared/ui';
import type { Environment } from '@shared/contracts';
import { EnvironmentRow } from './environment-row';
import { EnvironmentScreen, ProjectEnvironmentScreen } from './environment-screen';
import { EnvironmentSummary } from './environment-summary';

/**
 * `/settings/projects/:slug/environment` (#750): one project's secrets — only its rows, from its own scoped status
 * call — in a section per environment that has any (this console's first), required before optional, each row a
 * link to its guide. The environments with nothing to set share one quiet line. A sign-in that may not see them
 * (403) sees no row names at all; an unknown, archived or out-of-scope project reads as the setup page's not-found.
 */
@Component({
  selector: 'tc-project-environment-page',
  imports: [
    Button,
    EnvironmentRow,
    EnvironmentSummary,
    Icon,
    RouterLink,
    RouterOutlet,
    StateBlock,
    TranslocoPipe,
  ],
  providers: [
    ProjectEnvironmentScreen,
    { provide: EnvironmentScreen, useExisting: ProjectEnvironmentScreen },
  ],
  templateUrl: './project-environment.page.html',
  styleUrls: ['../settings-subpage.css', './environment-layout.css', './project-environment.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'closeGuide()' },
})
export class ProjectEnvironmentPage {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(ConsoleLanguage);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly projects = inject(ProjectsStore);

  protected readonly screen = inject(ProjectEnvironmentScreen);
  protected readonly status = this.screen.status;
  protected readonly copy = inject(EnvironmentCopy);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly slug = this.screen.slug;
  protected readonly name = this.screen.projectName;
  protected readonly view = this.screen.view;
  protected readonly setupRoute = computed(() => projectSetupRouteOf(this.slug()));
  protected readonly checking = computed(() => this.status().state() === 'loading');
  protected readonly forbidden = computed(() => this.status().problem()?.kind === 'forbidden');
  /** 404 from the scoped call, or a slug the project list does not have: one not-found, no oracle. */
  protected readonly notFound = computed(
    () =>
      this.status().problem()?.kind === 'not-found' ||
      (this.projects.status() === 'ready' && this.projects.bySlug(this.slug()) === undefined),
  );
  /** "В dev, stage и на вашем компьютере": built from the list, never hard-coded. */
  protected readonly quietList = computed(() => {
    this.language.active();
    const words = this.view().quiet.map((environment) =>
      environment === 'local' ? this.transloco.translate('env.project.list.local') : environment,
    );
    const last = words.pop();
    if (last === undefined) {
      return '';
    }
    return words.length === 0
      ? last
      : `${words.join(', ')}${this.transloco.translate('env.project.list.and')}${last}`;
  });

  constructor() {
    let focusedFor: string | null = null;
    // Entry focus on the h1 once it is there (the not-found and forbidden states have their own h1 too).
    effect(() => {
      const heading = this.heading();
      const slug = this.slug();
      if (heading !== undefined && focusedFor !== slug && untracked(() => this.screen.openId()) === null) {
        focusedFor = slug;
        afterNextRender(() => heading.nativeElement.focus(), { injector: this.injector });
      }
    });
    effect(() => {
      const open = this.screen.openId();
      const last = untracked(() => this.screen.lastOpenedId());
      if (open === null && last !== null) {
        afterNextRender(() => this.focusRow(last), { injector: this.injector });
      }
    });
  }

  protected linkOf(environment: Environment, view: RowView): readonly string[] {
    return this.screen.guideRouteOf(environment, view);
  }

  protected summaryTitle(section: ProjectSectionView): string {
    const params = { project: this.name(), env: section.environment };
    return section.missing > 0
      ? this.transloco.translate(
          pluralKeyOf('env.project.sum.missing', this.language.active(), section.missing),
          {
            ...params,
            n: section.missing,
          },
        )
      : this.transloco.translate('env.project.sum.ok', params);
  }

  protected otherLine(section: ProjectSectionView): string {
    const current = this.screen.thisEnvironment();
    return current === null
      ? this.transloco.translate('env.sum.otherUnknown', { env: section.environment })
      : this.transloco.translate('env.sum.other', { this: current, env: section.environment });
  }

  protected jumpToFirstMissing(section: ProjectSectionView): void {
    const first = section.firstMissing;
    if (first !== null) {
      this.focusRow(first.row.id);
    }
  }

  protected async retryCopy(): Promise<void> {
    const hadFailed = this.copy.failed();
    if (await this.copy.ready()) {
      return;
    }
    // As on the operator screen: a failed dynamic import stays failed, a reload is the way back.
    if (hadFailed) {
      this.document.location.reload();
    }
  }

  protected closeGuide(): void {
    if (this.screen.openId() !== null) {
      void this.router.navigate(this.screen.listRouteOf());
    }
  }

  private focusRow(id: string): void {
    const link = this.host.nativeElement.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    link?.focus();
  }
}
