import {
  MODEL_ALLOW_LIST,
  TEAM_CONFIG_BOUNDS,
  isResolvedTeamConfig,
  type AccessSource,
  type ResolvedTeamConfigDto,
} from '@shared/contracts';
import { LaunchRefusal } from '../jobs/refusal';
import { DEFAULT_JOB_SETTINGS, type JobSettings } from './managed-settings';
import { ROLE_MODELS, jobRoleOf, type JobRole } from './roles';

/**
 * How one job runs, from the claim's resolved team configuration (ADR 0009 d.5, d.6, "Where each field is enforced";
 * threat model T5, T7, T11). The runner re-validates the view with the shared guard and refuses the launch on any
 * failure rather than trust the console's answer; a claim without a view (an older console) runs on `ROLE_MODELS`
 * exactly as before. Nothing here reaches a shell: the model and the turn limit become argv elements, the effort an
 * enum value in the settings file.
 */

/** `full`: today's clone; `diff`: blob-less and one commit deep, for a `reviewer` job on `cost.reviewer_context: diff`. */
export type CloneContext = 'full' | 'diff';

/**
 * Each `cost.*` lever's status for the job's event: `applied`; `off` (the owner switched it off); `unsupported`
 * (`batch_api` has no execution path under `api_key` — every job is an interactive agent loop, ADR 0009 d.5
 * addendum, #689); `not-applied` (the project runs on a subscription, where the levers are ignored, or the claim
 * had no view); `not-applicable` (`reviewer_context` on a role other than `reviewer`).
 */
export type CostLeverStatus = 'applied' | 'off' | 'unsupported' | 'not-applied' | 'not-applicable';
export type CostLever = 'prompt_caching' | 'batch_api' | 'reviewer_context';

export interface JobLaunchPlan {
  readonly role: JobRole;
  readonly model: string;
  /** `--max-turns`; `null` without a view (the CLI's own default). */
  readonly maxTurns: number | null;
  readonly settings: JobSettings;
  /** `null` without a view: no credential-kind check, as before. */
  readonly accessSource: AccessSource | null;
  readonly clone: CloneContext;
  readonly cost: Readonly<Record<CostLever, CostLeverStatus>>;
  readonly revision: number | null;
}

const NOT_APPLIED: Readonly<Record<CostLever, CostLeverStatus>> = {
  prompt_caching: 'not-applied',
  batch_api: 'not-applied',
  reviewer_context: 'not-applied',
};

function costOf(view: ResolvedTeamConfigDto, role: JobRole): Readonly<Record<CostLever, CostLeverStatus>> {
  if (view.access.source !== 'api_key') {
    return NOT_APPLIED;
  }
  const { cost } = view;
  return {
    prompt_caching: cost.prompt_caching ? 'applied' : 'off',
    batch_api: cost.batch_api ? 'unsupported' : 'off',
    reviewer_context: cost.reviewer_context === 'repo' ? 'off' : role === 'reviewer' ? 'applied' : 'not-applicable',
  };
}

/** A pinned id of the allow-list and a turn limit in bound: the guard checked both; argv is built from nothing else. */
function assertLaunchValues(model: string, maxTurns: number): void {
  const { min, max } = TEAM_CONFIG_BOUNDS.maxTurns;
  if (!(MODEL_ALLOW_LIST as readonly string[]).includes(model) || !Number.isSafeInteger(maxTurns) || maxTurns < min || maxTurns > max) {
    throw new LaunchRefusal('team-config-invalid', 'the claim’s team configuration names a model or a turn limit outside its bounds');
  }
}

/**
 * The plan for `role` from the claim's `teamConfig`: `undefined` when the claim carried none, anything else is judged
 * by `isResolvedTeamConfig`. The refusal names no value of the view.
 */
export function launchPlanOf(role: string, teamConfig: unknown): JobLaunchPlan {
  const jobRole = jobRoleOf(role);
  if (teamConfig === undefined) {
    return {
      role: jobRole,
      model: ROLE_MODELS[jobRole],
      maxTurns: null,
      settings: DEFAULT_JOB_SETTINGS,
      accessSource: null,
      clone: 'full',
      cost: NOT_APPLIED,
      revision: null,
    };
  }
  if (!isResolvedTeamConfig(teamConfig)) {
    throw new LaunchRefusal('team-config-invalid', 'the claim’s team configuration is not a valid team-config/v1 view');
  }
  const entry = teamConfig.roles[jobRole];
  assertLaunchValues(entry.model, entry.max_turns);
  const cost = costOf(teamConfig, jobRole);
  return {
    role: jobRole,
    model: entry.model,
    maxTurns: entry.max_turns,
    settings: { effort: entry.effort, promptCaching: cost.prompt_caching !== 'off' },
    accessSource: teamConfig.access.source,
    clone: cost.reviewer_context === 'applied' ? 'diff' : 'full',
    cost,
    revision: teamConfig.revision,
  };
}

/** The per-job status event's payload (ADR 0009 d.5): enums, ids and numbers only. */
export function teamConfigNoticeOf(plan: JobLaunchPlan): Record<string, unknown> {
  return {
    teamConfig:
      plan.revision === null
        ? { view: 'absent', model: plan.model }
        : {
            revision: plan.revision,
            source: plan.accessSource,
            model: plan.model,
            maxTurns: plan.maxTurns,
            effort: plan.settings.effort,
            clone: plan.clone,
          },
    cost: { ...plan.cost },
  };
}
