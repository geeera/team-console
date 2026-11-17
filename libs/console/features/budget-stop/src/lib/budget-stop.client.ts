import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { BudgetResume, budgetFailureOf, type BudgetActionResult } from '@console/entities/team-run';
import { TEAM_CONFIG_SCHEMA, type TeamConfig } from '@shared/contracts';
import { firstValueFrom } from 'rxjs';

export type { BudgetActionFailure, BudgetActionResult } from '@console/entities/team-run';
export { teamResumeUrl } from '@console/entities/team-run';

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

/**
 * The Needs-you budget row's two actions (#684). "Resume this month" is `BudgetResume` of `@console/entities/team-run`,
 * shared with the Settings › Team callout (#688): it lifts any pause and waives the budget for the rest of the UTC
 * month when the month has reached it. "Raise budget" saves the stored team configuration with a new
 * `budget.monthly_usd` over the revision it just read (`If-Match`), and the save lifts the stop when the new budget is
 * above the month's spend. Never throws for an HTTP failure: every outcome is a `BudgetActionResult`.
 */
@Injectable({ providedIn: 'root' })
export class BudgetStopClient {
  private readonly http = inject(HttpClient);
  private readonly budgetResume = inject(BudgetResume);

  resume(slug: string): Promise<BudgetActionResult> {
    return this.budgetResume.resume(slug);
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
      return { ok: false, failure: budgetFailureOf(error) };
    }
  }
}
