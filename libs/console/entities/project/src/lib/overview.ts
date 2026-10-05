import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  isTeamRunState,
  problemSlugOf,
  type OverviewDto,
  type OverviewProjectDto,
  type OverviewSprintDto,
  type OverviewTeamState,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

/** `GET /api/v1/overview` (#27): every active project's row in one request. */
export const OVERVIEW_URL = '/api/v1/overview';

const DUE_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIssueNumber(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function isSprint(value: unknown): value is OverviewSprintDto {
  return (
    isRecord(value) &&
    isIssueNumber(value['number']) &&
    typeof value['title'] === 'string' &&
    typeof value['dueOn'] === 'string' &&
    DUE_DAY.test(value['dueOn']) &&
    isCount(value['planned']) &&
    isCount(value['shipped'])
  );
}

function isOverviewProject(value: unknown): value is OverviewProjectDto {
  if (!isRecord(value) || typeof value['slug'] !== 'string' || typeof value['name'] !== 'string') {
    return false;
  }
  if (value['kind'] === 'failed') {
    const problem = value['problem'];
    return (
      isRecord(problem) &&
      typeof problem['type'] === 'string' &&
      typeof problem['title'] === 'string' &&
      typeof problem['status'] === 'number'
    );
  }
  return (
    value['kind'] === 'read' &&
    isTeamRunState(value['team']) &&
    (value['sprint'] === null || isSprint(value['sprint'])) &&
    Array.isArray(value['needsYou']) &&
    value['needsYou'].every(isIssueNumber) &&
    typeof value['setup'] === 'boolean' &&
    (value['setupUrl'] === null || typeof value['setupUrl'] === 'string')
  );
}

export function isOverviewDto(value: unknown): value is OverviewDto {
  return (
    isRecord(value) &&
    typeof value['checkedAt'] === 'string' &&
    Array.isArray(value['projects']) &&
    value['projects'].every(isOverviewProject)
  );
}

/** A project's overview row as the page shows it. The sprint title is untrusted text: plain text only. */
export type OverviewProject =
  | {
      readonly kind: 'read';
      readonly slug: string;
      readonly name: string;
      readonly team: OverviewTeamState;
      readonly sprint: OverviewSprintDto | null;
      readonly needsYou: readonly number[];
      readonly setup: boolean;
    }
  | {
      readonly kind: 'failed';
      readonly slug: string;
      readonly name: string;
      /** The problem type slug, e.g. `github-app-not-installed`. */
      readonly problem: string;
    };

function overviewProjectOf(dto: OverviewProjectDto): OverviewProject {
  if (dto.kind === 'failed') {
    return {
      kind: 'failed',
      slug: dto.slug,
      name: dto.name,
      problem: problemSlugOf(dto.problem.type) ?? dto.problem.type,
    };
  }
  return {
    kind: 'read',
    slug: dto.slug,
    name: dto.name,
    team: dto.team,
    sprint: dto.sprint,
    needsYou: dto.needsYou,
    setup: dto.setup,
  };
}

/** The response did not have the overview's shape; nothing of it is shown. */
export class UnexpectedOverviewResponse extends Error {
  constructor() {
    super(`unexpected response shape from ${OVERVIEW_URL}`);
    this.name = 'UnexpectedOverviewResponse';
  }
}

/** Reads the overview. Errors propagate as `HttpErrorResponse` or `UnexpectedOverviewResponse`. */
@Injectable({ providedIn: 'root' })
export class OverviewApi {
  private readonly http = inject(HttpClient);

  async load(): Promise<OverviewProject[]> {
    const body = await firstValueFrom(this.http.get<unknown>(OVERVIEW_URL));
    if (!isOverviewDto(body)) {
      throw new UnexpectedOverviewResponse();
    }
    return body.projects.map(overviewProjectOf);
  }
}
