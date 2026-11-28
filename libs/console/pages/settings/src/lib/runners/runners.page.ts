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
import { AddRunner } from '@console/features/add-runner';
import { EnrolRunner } from '@console/features/enrol-runner';
import { ManageRunner } from '@console/features/manage-runner';
import { ProjectDispatchEditor } from '@console/features/project-dispatch';
import { RunnerPolicyEditor } from '@console/features/runner-policy';
import { teamSettingsUrlOf } from '@console/features/team-config';
import { LocalTimePipe, TranslocoPipe, TranslocoService } from '@console/shared/i18n';
import { Button, Field, FieldControl, Icon, injectRetryFocus, StateBlock } from '@console/shared/ui';
import { isRunnerScopeFixed, type PendingEnrolmentDto, type RunnerDto } from '@shared/contracts';

/**
 * `/settings/runners` (#464, ADR 0008 row 2-E part A): the account's runners — enrol a new one with a one-time
 * code, see each one's backend, version, presence and host, change the projects it may serve, revoke it — and the
 * placement policy, as the account default and per project, and per project whether its jobs run on these runners or
 * on GitHub Actions (#670). Owner-of-account only: anyone else is told so.
 */
@Component({
  selector: 'tc-runners-page',
  imports: [
    Button,
    Field,
    FieldControl,
    Icon,
    LocalTimePipe,
    ProjectDispatchEditor,
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
  private readonly addRunner = inject(AddRunner);
  private readonly enrol = inject(EnrolRunner);
  private readonly manage = inject(ManageRunner);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly restoreRetryFocus = injectRetryFocus(() => this.heading());

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
  /** Settings › Team of the picked project: where an `access-source-hosted` refusal sends the owner (#688). */
  protected readonly teamUrl = computed(() => {
    const slug = this.projectSlug();
    return slug === null ? null : teamSettingsUrlOf(slug);
  });
  protected readonly projectSlug = computed(() => {
    const picked = this.pickedSlug();
    const projects = this.projects();
    return picked !== null && projects.some((project) => project.slug === picked)
      ? picked
      : (projects[0]?.slug ?? null);
  });
  protected readonly projectScope = computed((): RunnerPolicyScope | null => {
    const slug = this.projectSlug();
    return slug === null ? null : { kind: 'project', slug };
  });

  /** #797: a hosted or Actions runner keeps the scope the console gave it; its card shows «Изменить проекты» locked. */
  protected readonly isScopeFixed = isRunnerScopeFixed;

  /** A saved account default changes what a project on the default runs on: its editor reads it again. */
  protected readonly accountRevision = signal(0);

  constructor() {
    void this.store.load();
    void this.projectsStore.ready();
    afterNextRender(() => this.heading().nativeElement.focus());
  }

  protected async reload(): Promise<void> {
    await this.store.load();
    this.restoreRetryFocus();
  }

  protected accountPolicySaved(): void {
    this.accountRevision.update((revision) => revision + 1);
  }

  protected pickProject(slug: string): void {
    this.pickedSlug.set(slug);
  }

  /**
   * «Подключить раннер» (#634 PR 4): the wizard for a Mac. Linux hands over to the one-time-code dialog with what the
   * owner typed (decision 1), and «Выбрать проекты» opens the new runner's scope editor: the page composes the two
   * features, neither imports the other.
   */
  protected async enrolRunner(): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const outcome = await this.addRunner.open({
      accountId: account.id,
      projects: this.projects(),
      releaseVersion: this.store.release().version,
    });
    switch (outcome.kind) {
      case 'closed':
        if (outcome.enrolled) {
          await this.store.load();
        }
        return;
      case 'code': {
        const { name, projectScope, allowedProjects } = outcome;
        const issued = await this.enrol.open({
          accountId: account.id,
          projects: this.projects(),
          prefill: { name, projectScope, allowedProjects },
        });
        if (issued) {
          // The runner appears once it has run `enrol` on its host; a fresh read shows it then.
          void this.store.load();
        }
        return;
      }
      case 'pick-projects': {
        await this.store.load();
        const runner = this.store.runners().find((row) => row.id === outcome.runnerId);
        if (runner !== undefined && !isRunnerScopeFixed(runner)) {
          await this.editProjects(runner);
        }
        return;
      }
    }
  }

  protected async editProjects(runner: RunnerDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const updated = await this.manage.editProjects({
      accountId: account.id,
      runner,
      projects: this.projects(),
    });
    if (updated !== null) {
      this.store.apply(updated);
    }
  }

  /** The locked «Изменить проекты» says why on a press instead of opening a save the Worker would refuse. */
  protected sayScopeFixed(): void {
    void this.announcer.announce(this.transloco.translate('runners.err.scopeFixed'), 'polite');
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

  protected async clearSuspect(runner: RunnerDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const outcome = await this.manage.clearSuspect({ accountId: account.id, runner });
    if (outcome.kind === 'cleared') {
      this.store.apply(outcome.runner);
      void this.announcer.announce(
        this.transloco.translate('runners.suspect.done', { name: outcome.runner.name }),
        'polite',
      );
    } else if (outcome.kind === 'stale') {
      void this.store.load();
    }
  }

  protected async claimEnroller(runner: RunnerDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const outcome = await this.manage.claimEnroller({ accountId: account.id, runner });
    if (outcome.kind === 'claimed') {
      this.store.apply(outcome.runner);
      void this.announcer.announce(
        this.transloco.translate('runners.enroller.done', { name: outcome.runner.name }),
        'polite',
      );
    } else if (outcome.kind === 'stale') {
      void this.store.load();
    }
  }

  protected async withdrawEnrolment(enrolment: PendingEnrolmentDto): Promise<void> {
    const account = this.store.account();
    if (account === null) {
      return;
    }
    const outcome = await this.manage.withdrawEnrolment(account.id, enrolment);
    if (outcome.kind === 'withdrawn') {
      this.store.dropPendingEnrolment(enrolment.id);
      void this.announcer.announce(
        this.transloco.translate('runners.pending.withdrawn', { name: enrolment.name }),
        'polite',
      );
    } else if (outcome.kind === 'stale') {
      void this.store.load();
    }
  }
}
