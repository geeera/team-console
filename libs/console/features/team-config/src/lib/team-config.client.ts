import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import {
  TEAM_CONFIG_SCHEMA,
  isResolvedTeamConfig,
  type TeamConfig,
  type TeamConfigDto,
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
    (value['updatedByName'] === null || typeof value['updatedByName'] === 'string') &&
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

  async save(slug: string, revision: number, config: TeamConfig, reason: string): Promise<TeamConfigSaveResult> {
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
