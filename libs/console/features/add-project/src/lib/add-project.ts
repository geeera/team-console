import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { GitHubConnectionStore } from '@console/entities/github-connection';
import {
  isProjectDtoList,
  PROJECTS_URL,
  ProjectSetupApi,
  ProjectsStore,
  setupStepsOf,
  type SetupStep,
} from '@console/entities/project';
import { httpProblemOf } from '@console/shared/api';
import type { ProjectDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { addOutcomeOf, type AddOutcome } from './add-outcome';

/** Every answer of an add except the transient ones: what a refusal shows (nothing was saved). */
export type AddRefusal = Exclude<AddOutcome, { readonly kind: 'checking' } | { readonly kind: 'exists' }>;

export type AddResult =
  | { readonly kind: 'added'; readonly slug: string }
  | { readonly kind: 'refused'; readonly outcome: AddRefusal };

function isProjectDto(value: unknown): value is ProjectDto {
  return isProjectDtoList([value]);
}

/**
 * Adding a project (#24, extracted for #194): `POST /api/v1/projects`, the refusal mapped by the problem's `type`
 * and `step` (`addOutcomeOf`), the project list refreshed after a save so the switcher shows it without a reload.
 * The New project form and the repository rows on All projects both go through here.
 */
@Injectable({ providedIn: 'root' })
export class AddProject {
  private readonly http = inject(HttpClient);
  private readonly projects = inject(ProjectsStore);
  private readonly connection = inject(GitHubConnectionStore);
  private readonly setupApi = inject(ProjectSetupApi);

  async add(repo: string, slug: string): Promise<AddResult> {
    let created: unknown;
    try {
      created = await firstValueFrom(this.http.post<unknown>(PROJECTS_URL, { repo }));
    } catch (error: unknown) {
      const outcome = addOutcomeOf(httpProblemOf(error));
      if (outcome.kind === 'not-connected') {
        this.connection.noteNotConnected();
      }
      return {
        kind: 'refused',
        outcome: outcome.kind === 'exists' ? await this.registeredOutcome(repo, slug) : outcome,
      };
    }
    if (isProjectDto(created)) {
      this.projects.upsert(created);
    } else {
      // A 201 whose body we cannot read: the project is saved, so the Worker's list is the truth.
      await this.projects.load();
    }
    return { kind: 'added', slug: isProjectDto(created) ? created.slug : slug };
  }

  /**
   * One add as All projects runs it (#194): the state the row and the sheet both show, Check again on the same
   * repository, and `onSettled` after every attempt — also when the sheet was closed while it ran.
   */
  start(repo: string, slug: string, onSettled: (state: AddJobState) => void): AddJob {
    return new AddJob(repo, slug, this, onSettled);
  }

  /** The steps after a save, as the setup page shows them; `null` when the read fails (the add itself stands). */
  async stepsAfterAdd(slug: string): Promise<readonly SetupStep[] | null> {
    try {
      const setup = await this.setupApi.get(slug);
      this.connection.syncFrom(setup.connection.state);
      return setupStepsOf(setup);
    } catch {
      // Only the checklist under "Project added" is missing; the sheet says so without it.
      return null;
    }
  }

  /** 409 `project-exists`: the Worker's list says whether it is on the list (link to its setup) or archived. */
  private async registeredOutcome(repo: string, slug: string): Promise<AddRefusal> {
    try {
      const project = await this.projects.findRegistered(repo, slug);
      if (project === null) {
        // Gone between the 409 and this read: nothing to link to; the owner can simply check again.
        return { kind: 'unavailable', reason: 'github' };
      }
      return project.archivedAt === null ? { kind: 'duplicate', slug: project.slug } : { kind: 'archived' };
    } catch (error: unknown) {
      const outcome = addOutcomeOf(httpProblemOf(error));
      return outcome.kind === 'exists' ? { kind: 'unavailable', reason: 'github' } : outcome;
    }
  }
}

export type AddJobState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'added'; readonly slug: string; readonly steps: readonly SetupStep[] | null }
  | { readonly kind: 'refused'; readonly outcome: AddRefusal };

/** One repository being added; `run()` again is Check again. */
export class AddJob {
  readonly state = signal<AddJobState>({ kind: 'checking' });

  constructor(
    readonly repo: string,
    readonly slug: string,
    private readonly adder: AddProject,
    private readonly onSettled: (state: AddJobState) => void,
  ) {}

  get isRunning(): boolean {
    return this.state().kind === 'checking';
  }

  async run(): Promise<AddJobState> {
    this.state.set({ kind: 'checking' });
    const result = await this.adder.add(this.repo, this.slug);
    const settled: AddJobState =
      result.kind === 'added'
        ? { kind: 'added', slug: result.slug, steps: await this.adder.stepsAfterAdd(result.slug) }
        : { kind: 'refused', outcome: result.outcome };
    this.state.set(settled);
    this.onSettled(settled);
    return settled;
  }
}
