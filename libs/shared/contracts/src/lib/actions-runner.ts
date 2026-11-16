import { isUlid } from './account';
import { isString } from './guards';
import { isJobDto, type ClaimResponse } from './job';
import { isEd25519PublicJwk, isRunnerId, isRunnerVersion, runnerHostOf, type Ed25519PublicJwk, type RunnerHostDto } from './runner';
import { isResolvedTeamConfig } from './team-config';
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

/** The claim response of `POST /runner/jobs/claim` plus the identity the run's runner JWTs are signed for. */
export type OidcExchangeResponse = ClaimResponse & {
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

export function isOidcExchangeResponse(value: unknown): value is OidcExchangeResponse {
  if (!isRecord(value) || !isRecord(value['runner'])) {
    return false;
  }
  const runner = value['runner'];
  return (
    isJobDto(value['job']) &&
    isString(value['jobToken']) &&
    typeof value['leaseSeconds'] === 'number' &&
    isResolvedTeamConfig(value['teamConfig']) &&
    (value['teamConfigRevision'] === null || Number.isSafeInteger(value['teamConfigRevision'])) &&
    isRunnerId(runner['id']) &&
    isString(runner['audience'])
  );
}
