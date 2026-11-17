import { isUlid } from './account';
import { isString } from './guards';
import { isJobDto, type ClaimResponse } from './job';
import { isEd25519PublicJwk, isRunnerId, isRunnerVersion, runnerHostOf, type Ed25519PublicJwk, type RunnerHostDto } from './runner';
import { InputError, checked, isRecord, oneOf, record, text, type InputCheck } from './tracker/inputs';

/**
 * GitHub Actions as a runner (#573, #668; ADR 0008 decision 7(a′), threat model C11 row 5). A workflow run in the
 * project's own repository presents a GitHub OIDC token; the console checks it against the project and gives that
 * one job an ephemeral runner identity. The names below are fixed in every customer repository (owner decision 3 on
 * #573), so the console can verify them without a per-project setting.
 */

/** How a project's jobs reach a runner: a pulling runner (every project today), or a dispatched workflow run (#670). */
export const PROJECT_DISPATCHES = ['pull', 'actions'] as const;
export type ProjectDispatch = (typeof PROJECT_DISPATCHES)[number];
export const isProjectDispatch = (value: unknown): value is ProjectDispatch =>
  (PROJECT_DISPATCHES as readonly unknown[]).includes(value);

/** The issuer of GitHub Actions OIDC tokens; fixed, never configurable (a deployment would trust any issuer it names). */
export const ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** The workflow file every customer repository runs; the token's `workflow_ref` must name it on the default branch. */
export const ACTIONS_WORKFLOW_FILE = 'team-console-runner.yml';
/** The GitHub Environment that holds the inference key and its default-branch policy (owner decision 3 on #573). */
export const ACTIONS_ENVIRONMENT = 'team-console';
/** The ephemeral runner's name: one per workflow run. */
const ACTIONS_RUNNER_NAME = /^actions:([1-9][0-9]{0,19})$/;
/** A GitHub run id as the OIDC token carries it: a decimal string. */
export const ACTIONS_RUN_ID = /^[1-9][0-9]{0,19}$/;
/**
 * The oldest token the exchange accepts, counted from its `iat` (#695): GitHub's tokens live minutes, and a run
 * exchanges right after it asks for one. jose also refuses an `iat` more than the clock tolerance in the future.
 */
export const OIDC_TOKEN_MAX_AGE = '10m';
/** An OIDC token is a JWS of a few kilobytes; anything far larger is refused before any parsing. */
export const OIDC_TOKEN_MAX_LENGTH = 8192;

export function actionsRunnerNameOf(runId: string): string {
  return `actions:${runId}`;
}

/** The run id an ephemeral runner's name carries, or `null` for any other name. */
export function actionsRunIdOf(name: string): string | null {
  return ACTIONS_RUNNER_NAME.exec(name)?.[1] ?? null;
}

/**
 * The claims the exchange verifies; `extensions.claim` of an `oidc-exchange-refused` problem names one of them.
 * `access_source` is the project's, not the token's: a `subscription` project never runs on an Actions machine.
 */
export const OIDC_EXCHANGE_CLAIMS = [
  'token',
  'iss',
  'aud',
  'exp',
  // #695: an `iat` in the future, or a token older than `OIDC_TOKEN_MAX_AGE`.
  'iat',
  'repository_id',
  'ref',
  'ref_type',
  'workflow_ref',
  'job_workflow_ref',
  'event_name',
  'environment',
  'runner_environment',
  'run_id',
  'job_id',
  'access_source',
] as const;
export type OidcExchangeClaim = (typeof OIDC_EXCHANGE_CLAIMS)[number];

/** `POST /api/v1/runner/oidc-exchange`: the run's OIDC token, the job it was dispatched for, and the VM's fresh key. */
export interface OidcExchangeInput {
  readonly idToken: string;
  readonly jobId: string;
  /** Generated in the VM's memory for this run; the private half never leaves it. */
  readonly publicKey: Ed25519PublicJwk;
  readonly version: string;
  readonly host: RunnerHostDto;
}

/**
 * The claim response of `POST /runner/jobs/claim` plus the identity the run's runner JWTs are signed for.
 * `teamConfig` is `unknown`, not `ResolvedTeamConfigDto` (#741): the job is already claimed by the time the exchange
 * answers, so a view the guard would reject must still reach `runJob`, which refuses the launch and finishes the job
 * (`team-config-invalid`) instead of this call throwing first and leaving the job to the lease.
 */
export type OidcExchangeResponse = Omit<ClaimResponse, 'teamConfig'> & {
  readonly teamConfig: unknown;
  readonly runner: { readonly id: string; readonly audience: string };
};

/** The body's shape; whether the token is good is the route's answer, one refusal type for every bad one. */
export function checkOidcExchangeInput(body: unknown): InputCheck<OidcExchangeInput> {
  return checked(() => {
    const fields = record(body, ['idToken', 'jobId', 'publicKey', 'version', 'host']);
    const publicKey = fields['publicKey'];
    if (!isEd25519PublicJwk(publicKey)) {
      throw new InputError('publicKey', 'publicKey must be an Ed25519 public JWK (kty OKP, crv Ed25519, x)');
    }
    return {
      idToken: text('idToken', fields['idToken'], OIDC_TOKEN_MAX_LENGTH, 1),
      jobId: oneOf('jobId', fields['jobId'], isUlid),
      publicKey: { kty: 'OKP', crv: 'Ed25519', x: publicKey.x },
      version: oneOf('version', fields['version'], isRunnerVersion),
      host: runnerHostOf(fields['host']),
    };
  });
}

/**
 * The envelope only: `teamConfig` is checked for presence, never its shape (#741). A malformed `job`, `jobToken` or
 * `runner` is still a protocol break the caller must throw on; a malformed `teamConfig` is the claim's problem and
 * `launchPlanOf` (`isResolvedTeamConfig`) refuses it with `team-config-invalid` once the job is running.
 */
export function isOidcExchangeResponse(value: unknown): value is OidcExchangeResponse {
  if (!isRecord(value) || !isRecord(value['runner'])) {
    return false;
  }
  const runner = value['runner'];
  return (
    isJobDto(value['job']) &&
    isString(value['jobToken']) &&
    typeof value['leaseSeconds'] === 'number' &&
    value['teamConfig'] !== undefined &&
    (value['teamConfigRevision'] === null || Number.isSafeInteger(value['teamConfigRevision'])) &&
    isRunnerId(runner['id']) &&
    isString(runner['audience'])
  );
}

/**
 * Why a dispatched job failed before any runner held it (#670), in `result.metrics.reason`: the console's
 * `workflow_dispatch` call failed (`dispatch-failed`; the summary names why, e.g. `permission missing`), or no run
 * exchanged a token for it within `ACTIONS_NO_SHOW_MINUTES` (`actions-no-show`).
 */
export const ACTIONS_DISPATCH_FAILED = 'dispatch-failed';
export const ACTIONS_NO_SHOW = 'actions-no-show';
export const ACTIONS_NO_SHOW_MINUTES = 15;

/** What a failed `workflow_dispatch` call is put down to, after `dispatch-failed: ` in the job's summary. */
export const ACTIONS_DISPATCH_FAILURES = [
  'permission missing',
  'installation missing',
  'repository mismatch',
  'workflow missing',
  'github unavailable',
  'github error',
] as const;
export type ActionsDispatchFailure = (typeof ACTIONS_DISPATCH_FAILURES)[number];

/** `GET|PUT /api/v1/projects/:slug/dispatch` (#670): how the project's jobs reach a runner. */
export interface ProjectDispatchDto {
  readonly dispatch: ProjectDispatch;
  /**
   * The repository's default branch as GitHub last named it (read from the repository API at the switch and at every
   * dispatch, never taken from input); `null` until GitHub was first asked.
   */
  readonly defaultBranch: string | null;
}

export interface ProjectDispatchInput {
  readonly dispatch: ProjectDispatch;
}

export function checkProjectDispatchInput(body: unknown): InputCheck<ProjectDispatchInput> {
  return checked(() => {
    const fields = record(body, ['dispatch']);
    return { dispatch: oneOf('dispatch', fields['dispatch'], isProjectDispatch) };
  });
}

export function isProjectDispatchDto(value: unknown): value is ProjectDispatchDto {
  return (
    isRecord(value) &&
    isProjectDispatch(value['dispatch']) &&
    (value['defaultBranch'] === null || (isString(value['defaultBranch']) && value['defaultBranch'] !== ''))
  );
}
