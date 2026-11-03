import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { isGitHubLogin, isGitHubPageUrl, type AddProjectStep, type ProjectSetupDto } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';
import { PROJECTS_URL } from './projects.store';

/** The five checklist steps of #24 in order: three gate adding, two are checked after saving. */
export const SETUP_STEP_IDS = ['app', 'owner', 'yml', 'events', 'routine'] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** As the checklist words it: `waiting` is the events step before the first event (approved copy «Ждём»). */
export type SetupStepState = 'done' | 'missing' | 'waiting' | 'pending' | 'skipped' | 'unknown';

export interface SetupStep {
  readonly id: SetupStepId;
  readonly state: SetupStepState;
  /** Why a step is `skipped`: the step above is not done, or no GitHub account is connected. */
  readonly skippedBecause?: 'previous' | 'not-connected';
}

export interface SetupSummary {
  /** Steps the owner still has to act on: missing, or not checked yet because a step above is not done. */
  readonly left: number;
  readonly unknown: number;
  readonly done: number;
  /** Steps that tick themselves (the first event, #205): never counted as left, never block `ready`. */
  readonly waiting: number;
  /** Nothing is left for the owner; `waiting` may still be above zero. */
  readonly ready: boolean;
}

export function setupUrlOf(slug: string): string {
  return `${PROJECTS_URL}/${encodeURIComponent(slug)}/setup`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isConnection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['state'] === 'not-connected' || (value['state'] === 'connected' && isGitHubLogin(value['login']))
  );
}

/** Narrows the Worker's answer; links in it must point at github.com before the client renders them. */
export function isProjectSetupDto(value: unknown): value is ProjectSetupDto {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOneOf(value['appInstalled'], ['ok', 'missing', 'unknown']) &&
    isOneOf(value['repoOwner'], ['ok', 'mismatch', 'not-checked', 'unknown']) &&
    isOneOf(value['projectYml'], ['ok', 'missing', 'unknown']) &&
    isOneOf(value['events'], ['seen', 'never']) &&
    (value['lastEventAt'] === null || typeof value['lastEventAt'] === 'string') &&
    isOneOf(value['routineToken'], ['present', 'missing']) &&
    isConnection(value['connection']) &&
    (value['installUrl'] === undefined || isGitHubPageUrl(value['installUrl'])) &&
    (value['repoOwnerLogin'] === undefined || isGitHubLogin(value['repoOwnerLogin']))
  );
}

/** The checklist as the Worker reported it (#15, #83): nothing here is guessed on the client. */
export function setupStepsOf(setup: ProjectSetupDto): readonly SetupStep[] {
  const app: SetupStep = {
    id: 'app',
    state: setup.appInstalled === 'ok' ? 'done' : setup.appInstalled === 'missing' ? 'missing' : 'unknown',
  };

  let owner: SetupStep;
  switch (setup.repoOwner) {
    case 'ok':
      owner = { id: 'owner', state: 'done' };
      break;
    case 'mismatch':
      owner = { id: 'owner', state: 'missing' };
      break;
    case 'unknown':
      owner = { id: 'owner', state: 'unknown' };
      break;
    case 'not-checked':
      owner =
        setup.appInstalled === 'ok'
          ? { id: 'owner', state: 'skipped', skippedBecause: 'not-connected' }
          : setup.appInstalled === 'unknown'
            ? { id: 'owner', state: 'unknown' }
            : { id: 'owner', state: 'skipped', skippedBecause: 'previous' };
      break;
  }

  // The Worker reports project.yml "missing" also when the app is not installed: it could not be read then.
  const yml: SetupStep =
    setup.appInstalled === 'missing'
      ? { id: 'yml', state: 'skipped', skippedBecause: 'previous' }
      : {
          id: 'yml',
          state: setup.projectYml === 'ok' ? 'done' : setup.projectYml === 'missing' ? 'missing' : 'unknown',
        };

  return [
    app,
    owner,
    yml,
    { id: 'events', state: setup.events === 'seen' ? 'done' : 'waiting' },
    { id: 'routine', state: setup.routineToken === 'present' ? 'done' : 'missing' },
  ];
}

/** Every step "Checking…" while a check runs. */
export function pendingSetupSteps(): readonly SetupStep[] {
  return SETUP_STEP_IDS.map((id) => ({ id, state: 'pending' }));
}

const REFUSED_AT: Readonly<Partial<Record<AddProjectStep, SetupStepId>>> = {
  'app-installed': 'app',
  'repo-owner': 'owner',
  'project-yml': 'yml',
};

/**
 * A refused add (#15 problem `step`): the steps before it passed, it is missing, and nothing after it was checked —
 * "Nothing was saved". Null for a step that is not one of the three GitHub checks.
 */
export function refusedSetupSteps(step: unknown): readonly SetupStep[] | null {
  const refused = typeof step === 'string' ? REFUSED_AT[step as AddProjectStep] : undefined;
  if (refused === undefined) {
    return null;
  }
  const at = SETUP_STEP_IDS.indexOf(refused);
  return SETUP_STEP_IDS.map((id, index) => {
    if (index < at) {
      return { id, state: 'done' };
    }
    return index === at ? { id, state: 'missing' } : { id, state: 'skipped', skippedBecause: 'previous' };
  });
}

export function setupSummaryOf(steps: readonly SetupStep[]): SetupSummary {
  const count = (...states: SetupStepState[]): number =>
    steps.filter((step) => states.includes(step.state)).length;
  const left = count('missing', 'skipped');
  const unknown = count('unknown');
  return {
    left,
    unknown,
    done: count('done'),
    waiting: count('waiting'),
    ready: steps.length > 0 && left === 0 && unknown === 0 && count('pending') === 0,
  };
}

/** `GET /api/v1/projects/:slug/setup`; `fresh` bypasses the Worker's 60 s cache of the GitHub part (`?fresh=1`). */
@Injectable({ providedIn: 'root' })
export class ProjectSetupApi {
  private readonly http = inject(HttpClient);

  async get(slug: string, options: { readonly fresh?: boolean } = {}): Promise<ProjectSetupDto> {
    const params = options.fresh === true ? new HttpParams().set('fresh', '1') : undefined;
    const body = await firstValueFrom(
      this.http.get<unknown>(setupUrlOf(slug), params === undefined ? {} : { params }),
    );
    if (!isProjectSetupDto(body)) {
      throw new Error('project setup: unexpected response shape');
    }
    return body;
  }
}
