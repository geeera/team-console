import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { isTeamStatusDto, teamStatusUrl } from '@console/entities/team-run';
import { httpProblemOf } from '@console/shared/api';
import {
  TEAM_CONFIG_IMPORT_NOTES,
  TEAM_CONFIG_SCHEMA,
  isResolvedTeamConfig,
  isTeamConfig,
  type TeamConfig,
  type TeamConfigChange,
  type TeamConfigDto,
  type TeamConfigImportDto,
  type TeamConfigImportNote,
  type TeamConfigRevisionDto,
  type TeamConfigRevisionSummaryDto,
  type TeamStatusDto,
} from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export function teamConfigUrlOf(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team-config`;
}

/** Why a read did not give a view: the project is not in scope (404), or anything else (network, 5xx, a bad body). */
export type TeamConfigLoadResult =
  | { readonly ok: true; readonly view: TeamConfigDto }
  | { readonly ok: false; readonly failure: 'not-found' | 'failed' };

/** How a save ended, in the terms the screen branches on (UX spec §2.4). */
export type TeamConfigSaveResult =
  | { readonly kind: 'saved'; readonly view: TeamConfigDto }
  /** 422 `team-config-invalid`/`-schema`: `field` is the document path the Worker named. */
  | { readonly kind: 'invalid'; readonly field: string }
  /** 422 `access-source-hosted`: a hosted runner or an Actions dispatch can reach the project. */
  | { readonly kind: 'hosted' }
  /** 412: someone saved another revision since this one was read. */
  | { readonly kind: 'stale' }
  /** 403: the caller is not (or no longer) the project's owner. */
  | { readonly kind: 'forbidden' }
  /** No response (offline, aborted) or a 5xx: the edits stay and the owner may try again. */
  | { readonly kind: 'failed' };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

export function teamConfigRevisionsUrlOf(slug: string): string {
  return `${teamConfigUrlOf(slug)}/revisions`;
}

export function teamConfigImportUrlOf(slug: string): string {
  return `${teamConfigUrlOf(slug)}/import`;
}

/** The history's page size: the route's maximum. */
export const HISTORY_PAGE_SIZE = 100;
/**
 * The newest revisions the history keeps. `GET …/revisions` pages oldest first (`after`), and revisions are numbered
 * 1..n with no gaps, so the read starts `HISTORY_WINDOW` below the revision the page shows and keeps the last
 * `HISTORY_WINDOW` it gets: the newest are always there; older ones stay reachable by the API.
 */
export const HISTORY_WINDOW = 500;
/** A bound on the pages one read takes, for revisions saved meanwhile; past it the read stops with what it has. */
export const HISTORY_MAX_PAGES = 20;

function isRevisionSummary(value: unknown): value is TeamConfigRevisionSummaryDto {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['revision']) &&
    isText(value['createdAt']) &&
    isText(value['createdBy']) &&
    isTextOrNull(value['createdByName']) &&
    isTextOrNull(value['reason']) &&
    Array.isArray(value['paths']) &&
    value['paths'].every(isText)
  );
}

function isChange(value: unknown): value is TeamConfigChange {
  return isRecord(value) && isText(value['path']);
}

export function isTeamConfigRevision(value: unknown): value is TeamConfigRevisionDto {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['revision']) &&
    isTeamConfig(value['config']) &&
    Array.isArray(value['diff']) &&
    value['diff'].every(isChange) &&
    isText(value['createdAt']) &&
    isText(value['createdBy']) &&
    isTextOrNull(value['createdByName']) &&
    isTextOrNull(value['reason'])
  );
}

function isImportNote(value: unknown): value is TeamConfigImportNote {
  return (
    isRecord(value) &&
    isText(value['path']) &&
    (TEAM_CONFIG_IMPORT_NOTES as readonly unknown[]).includes(value['code'])
  );
}

export function isTeamConfigImport(value: unknown): value is TeamConfigImportDto {
  const source = isRecord(value) ? value['source'] : undefined;
  return (
    isRecord(value) &&
    isTeamConfig(value['draft']) &&
    Array.isArray(value['notes']) &&
    value['notes'].every(isImportNote) &&
    isRecord(source) &&
    isText(source['path']) &&
    isText(source['ref']) &&
    isText(source['sha'])
  );
}

/** The history newest first, or why it is not there: the page around it stays as it is (UX spec §4 "Partial"). */
export type TeamHistoryResult =
  | {
      readonly ok: true;
      readonly revisions: readonly TeamConfigRevisionSummaryDto[];
      readonly isCut: boolean;
    }
  | { readonly ok: false };

export type TeamRevisionResult =
  { readonly ok: true; readonly revision: TeamConfigRevisionDto } | { readonly ok: false };

/** Why an import gave no draft: the file is missing or not a document we read, the limit, or no answer. */
export type TeamImportFailure = 'unreadable' | 'rate-limited' | 'forbidden' | 'failed';

export type TeamImportResult =
  | { readonly ok: true; readonly draft: TeamConfigImportDto }
  | { readonly ok: false; readonly failure: TeamImportFailure };

/**
 * The members the screen reads, checked before use: the Worker is ours, but a cached or truncated body must turn
 * into the error state, not a half-drawn form. `resolved` goes through the runner's own guard.
 */
export function isTeamConfigView(value: unknown): value is TeamConfigDto {
  if (!isRecord(value)) {
    return false;
  }
  const config = value['config'];
  const budget = value['budget'];
  return (
    (config === null || (isRecord(config) && config['schema'] === TEAM_CONFIG_SCHEMA)) &&
    Number.isSafeInteger(value['revision']) &&
    isRecord(budget) &&
    (budget['monthly_usd'] === null || Number.isSafeInteger(budget['monthly_usd'])) &&
    isResolvedTeamConfig(value['resolved']) &&
    (value['updatedAt'] === null || typeof value['updatedAt'] === 'string') &&
    isTextOrNull(value['updatedByName']) &&
    isTextOrNull(value['reason']) &&
    typeof value['canManage'] === 'boolean' &&
    typeof value['subscriptionBlocked'] === 'boolean'
  );
}

/**
 * `GET|PUT …/team-config` for Settings › Team (#688). Never throws for an HTTP failure: every outcome is a result
 * the screen words. The owner signal (`canManage`) and the subscription refusal come from the Worker's read, never
 * from anything the client decides.
 */
@Injectable({ providedIn: 'root' })
export class TeamConfigClient {
  private readonly http = inject(HttpClient);

  async load(slug: string): Promise<TeamConfigLoadResult> {
    try {
      const body: unknown = await firstValueFrom(this.http.get<unknown>(teamConfigUrlOf(slug)));
      return isTeamConfigView(body) ? { ok: true, view: body } : { ok: false, failure: 'failed' };
    } catch (error: unknown) {
      return { ok: false, failure: httpProblemOf(error).status === 404 ? 'not-found' : 'failed' };
    }
  }

  /**
   * The newest `HISTORY_WINDOW` revisions, newest first, read from just below `latest` (the revision the page shows)
   * to the end. `isCut` when older revisions exist that the list leaves out.
   */
  async history(slug: string, latest: number): Promise<TeamHistoryResult> {
    const start = Math.max(0, latest - HISTORY_WINDOW);
    const revisions: TeamConfigRevisionSummaryDto[] = [];
    let after = start;
    let isComplete = false;
    try {
      for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
        const body: unknown = await firstValueFrom(
          this.http.get<unknown>(teamConfigRevisionsUrlOf(slug), {
            params: { after: String(after), limit: String(HISTORY_PAGE_SIZE) },
          }),
        );
        if (
          !isRecord(body) ||
          !Array.isArray(body['revisions']) ||
          !body['revisions'].every(isRevisionSummary)
        ) {
          return { ok: false };
        }
        revisions.push(...body['revisions']);
        const next = body['nextCursor'];
        if (next === null) {
          isComplete = true;
          break;
        }
        if (!Number.isSafeInteger(next) || (next as number) <= after) {
          return { ok: false };
        }
        after = next as number;
      }
    } catch {
      // Network, 4xx or 5xx alike: the screen shows its own failure with Try again; nothing else depends on it.
      return { ok: false };
    }
    const kept = revisions.slice(-HISTORY_WINDOW);
    return {
      ok: true,
      revisions: kept.reverse(),
      isCut: start > 0 || kept.length < revisions.length || !isComplete,
    };
  }

  async revision(slug: string, revision: number): Promise<TeamRevisionResult> {
    try {
      const body: unknown = await firstValueFrom(
        this.http.get<unknown>(`${teamConfigRevisionsUrlOf(slug)}/${String(revision)}`),
      );
      return isTeamConfigRevision(body) ? { ok: true, revision: body } : { ok: false };
    } catch {
      // Network, 4xx or 5xx alike: the screen shows its own failure with Try again; nothing else depends on it.
      return { ok: false };
    }
  }

  /** `POST …/import`: a draft from the default branch's project.yml. It never saves anything. */
  async importDraft(slug: string): Promise<TeamImportResult> {
    try {
      const body: unknown = await firstValueFrom(this.http.post<unknown>(teamConfigImportUrlOf(slug), {}));
      return isTeamConfigImport(body) ? { ok: true, draft: body } : { ok: false, failure: 'failed' };
    } catch (error: unknown) {
      const { status } = httpProblemOf(error);
      const failure: TeamImportFailure =
        status === 422
          ? 'unreadable'
          : status === 429
            ? 'rate-limited'
            : status === 403
              ? 'forbidden'
              : 'failed';
      return { ok: false, failure };
    }
  }

  /** The team's state and the month's budget (#737); `null` when it cannot be read — the page works without it. */
  async teamStatus(slug: string): Promise<TeamStatusDto | null> {
    try {
      const body: unknown = await firstValueFrom(this.http.get<unknown>(teamStatusUrl(slug)));
      return isTeamStatusDto(body) ? body : null;
    } catch {
      // The callout and the waiver line are extras: the form still works without the month's figures.
      return null;
    }
  }

  async save(
    slug: string,
    revision: number,
    config: TeamConfig,
    reason: string,
  ): Promise<TeamConfigSaveResult> {
    const text = reason.trim();
    try {
      const body: unknown = await firstValueFrom(
        this.http.put<unknown>(
          teamConfigUrlOf(slug),
          { config, reason: text === '' ? null : text },
          { headers: { 'If-Match': `"${String(revision)}"` } },
        ),
      );
      return isTeamConfigView(body) ? { kind: 'saved', view: body } : { kind: 'failed' };
    } catch (error: unknown) {
      return saveFailureOf(error);
    }
  }
}

function saveFailureOf(error: unknown): TeamConfigSaveResult {
  const problem = httpProblemOf(error);
  if (problem.status === 412) {
    return { kind: 'stale' };
  }
  if (problem.status === 403) {
    return { kind: 'forbidden' };
  }
  if (problem.status === 422 && problem.slug === 'access-source-hosted') {
    return { kind: 'hosted' };
  }
  const field = problem.extensions['field'];
  if (problem.status === 422 && typeof field === 'string') {
    return { kind: 'invalid', field };
  }
  return { kind: 'failed' };
}
