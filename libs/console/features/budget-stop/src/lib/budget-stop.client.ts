import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { httpProblemOf } from '@console/shared/api';
import { TEAM_CONFIG_SCHEMA, type TeamConfig } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

/** Why a budget action did not happen, in the terms the dialog words it by. */
export type BudgetActionFailure = 'forbidden' | 'stale' | 'offline' | 'failed';

export type BudgetActionResult =
  { readonly ok: true } | { readonly ok: false; readonly failure: BudgetActionFailure };

export function teamResumeUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team/resume`;
}

export function teamConfigUrl(slug: string): string {
  return `/api/v1/projects/${encodeURIComponent(slug)}/team-config`;
}

interface StoredTeamConfig {
  readonly config: TeamConfig | null;
  readonly revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The two members of `GET …/team-config` the raise needs; the Worker checks the document it gets back in full. */
function isStoredTeamConfig(value: unknown): value is StoredTeamConfig {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['revision']) &&
    (value['config'] === null ||
      (isRecord(value['config']) && value['config']['schema'] === TEAM_CONFIG_SCHEMA))
  );
}

function failureOf(error: unknown): BudgetActionFailure {
  const problem = httpProblemOf(error);
  if (problem.status === 0) {
    return 'offline';
  }
  if (problem.status === 403) {
    return 'forbidden';
  }
  return problem.status === 412 || problem.slug === 'team-config-stale' ? 'stale' : 'failed';
}

/**
 * The Needs-you budget row's two actions (#684). "Resume this month" is the team resume with `waiveBudget`: it lifts
 * any pause and waives the budget for the rest of the UTC month when the month has reached it (a stop left over from
 * an earlier month is lifted with no waiver). Only this row sends it, after its confirm (#733). "Raise budget" saves the stored team configuration with
 * a new `budget.monthly_usd` over the revision it just read (`If-Match`), and the save lifts the stop when the new
 * budget is above the month's spend. Never throws for an HTTP failure: every outcome is a `BudgetActionResult`.
 */
@Injectable({ providedIn: 'root' })
export class BudgetStopClient {
  private readonly http = inject(HttpClient);

  async resume(slug: string): Promise<BudgetActionResult> {
    try {
      await firstValueFrom(this.http.post<unknown>(teamResumeUrl(slug), { waiveBudget: true }));
      return { ok: true };
    } catch (error: unknown) {
      // Resumed meanwhile (another device, or a raised budget): what the owner asked for already holds.
      return httpProblemOf(error).slug === 'team-not-paused'
        ? { ok: true }
        : { ok: false, failure: failureOf(error) };
    }
  }

  async raise(slug: string, monthlyUsd: number): Promise<BudgetActionResult> {
    try {
      // Read on every attempt, so Try again after a 412 saves over the revision that won.
      const stored: unknown = await firstValueFrom(this.http.get<unknown>(teamConfigUrl(slug)));
      if (!isStoredTeamConfig(stored)) {
        return { ok: false, failure: 'failed' };
      }
      const config: TeamConfig = {
        ...(stored.config ?? { schema: TEAM_CONFIG_SCHEMA }),
        budget: { monthly_usd: monthlyUsd },
      };
      await firstValueFrom(
        this.http.put<unknown>(
          teamConfigUrl(slug),
          { config },
          { headers: { 'If-Match': `"${String(stored.revision)}"` } },
        ),
      );
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, failure: failureOf(error) };
    }
  }
}
