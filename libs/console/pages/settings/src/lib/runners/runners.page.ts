import { LiveAnnouncer } from '@angular/cdk/a11y';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectsStore } from '@console/entities/project';
import {
  RunnerCard,
  RunnersStore,
  runnerFailureKeyOf,
  type RunnerPolicyScope,
  type RunnerProjectOption,
} from '@console/entities/runner';
import { EnrolRunner } from '@console/features/enrol-runner';
import { ManageRunner } from '@console/features/manage-runner';
import { RunnerPolicyEditor } from '@console/features/runner-policy';
import { TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Field, FieldControl, Icon, StateBlock } from '@console/shared/ui';
import type { RunnerDto } from '@shared/contracts';

/**
 * `/settings/runners` (#464, ADR 0008 row 2-E part A): the account's runners — enrol a new one with a one-time
 * code, see each one's backend, version, presence and host, change the projects it may serve, revoke it — and the
 * placement policy, as the account default and per project. Owner-of-account only: anyone else is told so.
 */
@Component({
  selector: 'tc-runners-page',
  imports: [
    Button,
    Field,
    FieldControl,
    Icon,
    RouterLink,
    RunnerCard,
    RunnerPolicyEditor,
    StateBlock,
    TranslocoPipe,
  ],
  templateUrl: './runners.page.html',
  styleUrls: ['../settings-subpage.css', './runners.page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunnersPage {
  protected readonly store = inject(RunnersStore);
  private readonly projectsStore = inject(ProjectsStore);
  private readonly enrol = inject(EnrolRunner);
  private readonly manage = inject(ManageRunner);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly projects = computed((): readonly RunnerProjectOption[] =>
    this.projectsStore.active().map((project) => ({ slug: project.slug, displayName: project.displayName })),
  );
  protected readonly failureText = computed(() => {
    const failure = this.store.failure();
    return failure === null ? '' : this.transloco.translate(runnerFailureKeyOf(failure));
  });
  protected readonly accountScope = computed((): RunnerPolicyScope | null => {
    const account = this.store.account();
    return account === null ? null : { kind: 'account', accountId: account.id };
  });
  /** The project whose own policy is open in the editor; the first active project until the owner picks another. */
  private readonly pickedSlug = signal<string | null>(null);
  protected readonly projectSlug = computed(() => {
    const picked = this.pickedSlug();
    const projects = this.projects();
    return picked !== null && projects.some((project) => project.slug === picked) ? picked : (projects[0]?.slug ?? null);
  });
  protected readonly projectScope = computed((): RunnerPolicyScope | null => {
    const slug = this.projectSlug();
    return slug === null ? null : { kind: 'project', slug };
  });

  /** A saved account default changes what a project on the default runs on: its editor reads it again. */
  protected readonly accountRevision = signal(0);

  constructor() {
    void this.store.load();
    void this.projectsStore.ready();
    afterNextRender(() => this.heading().nativeElement.focus());
  }

  protected reload(): void {
    void this.store.load();
  }

  protected accountPolicySaved(): void {
    this.accountRevision.update((revision) => revision + 1);
  }

  protected pickProject(slug: string): void {
    this.pickedSlug.set(slug);
  }

  protected async enrolRunner(): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const issued = await this.enrol.open({ accountId: account.id, projects: this.projects() });
    if (issued) {
      // The runner appears once it has run `enrol` on its host; a fresh read shows it then.
      void this.store.load();
    }
  }

  protected async editProjects(runner: RunnerDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const updated = await this.manage.editProjects({ accountId: account.id, runner, projects: this.projects() });
    if (updated !== null) {
      this.store.apply(updated);
    }
  }

  protected async revoke(runner: RunnerDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const outcome = await this.manage.revoke({ accountId: account.id, runner });
    if (outcome.kind === 'revoked') {
      this.store.apply(outcome.runner);
      void this.announcer.announce(
        this.transloco.translate('runners.revoke.done', { name: outcome.runner.name }),
        'polite',
      );
    } else if (outcome.kind === 'stale') {
      void this.store.load();
    }
  }
}
