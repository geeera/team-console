import { isUlid } from './account';
import { isString } from './guards';
import { isJobDto, type ClaimResponse } from './job';
import { isEd25519PublicJwk, isRunnerId, isRunnerVersion, runnerHostOf, type Ed25519PublicJwk, type RunnerHostDto } from './runner';
import { isAccessSource, type AccessSource } from './team-config';
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
/** The one secret of that Environment (#759): the console checks it exists by this name, never reads anything else. */
export const ACTIONS_INFERENCE_KEY_SECRET = 'TC_INFERENCE_API_KEY';
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

/**
 * `GET /api/v1/projects/:slug/actions-setup/workflow` (#759): this console's rendering of the runner workflow, for the
 * Copy path and for showing what the setup PR will contain. `version` is the runner release the file pins.
 */
export interface ActionsWorkflowDto {
  readonly text: string;
  /** Lower-case hex SHA-256 of `text` as UTF-8. */
  readonly sha256: string;
  readonly version: string;
}

export function isActionsWorkflowDto(value: unknown): value is ActionsWorkflowDto {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return false;
  }
  const { text: body, sha256, version } = value;
  return (
    isString(body) &&
    body !== '' &&
    isString(sha256) &&
    /^[0-9a-f]{64}$/.test(sha256) &&
    isString(version) &&
    /^\d+\.\d+\.\d+$/.test(version)
  );
}

/**
 * `GET /api/v1/projects/:slug/actions-setup` (#759; architect note §4, security note rows "Readiness over-reads or
 * leaks" and "Readiness used as authorisation"): whether the project's repository is set up for GitHub Actions, item
 * by item, in the order of the setup page's steps. Every item is re-read from GitHub on each check; nothing is stored.
 */
export const ACTIONS_SETUP_ITEMS = [
  'access-source',
  'app-permissions',
  'environment',
  'branch-policy',
  'protection-rules',
  'secret',
  'workflow',
] as const;
export type ActionsSetupItemId = (typeof ACTIONS_SETUP_ITEMS)[number];
export const isActionsSetupItemId = (value: unknown): value is ActionsSetupItemId =>
  (ACTIONS_SETUP_ITEMS as readonly unknown[]).includes(value);

/**
 * `unknown`: the console could not look (the app has not been granted the permission yet); it never counts as ok.
 * `outdated` (#870): the file is this console's rendering with older version pins (and their checksums) and nothing
 * else changed; jobs still run on it, so it does not hold the switch back. `unsupported`: the same, but its runner is
 * below the environment's `RUNNER_MINIMUM_VERSION`, so it does.
 */
export const ACTIONS_SETUP_STATUSES = ['ok', 'missing', 'wrong', 'outdated', 'unsupported', 'modified', 'unknown'] as const;
export type ActionsSetupStatus = (typeof ACTIONS_SETUP_STATUSES)[number];
export const isActionsSetupStatus = (value: unknown): value is ActionsSetupStatus =>
  (ACTIONS_SETUP_STATUSES as readonly unknown[]).includes(value);

/**
 * Items that warn and never hold the switch back (owner decision 2 on #759): required reviewers or a wait timer on
 * the Environment are the customer's stronger control; every run then waits for them and may hit the no-show limit.
 */
export const ACTIONS_SETUP_ADVISORY_ITEMS: readonly ActionsSetupItemId[] = Object.freeze(['protection-rules']);

/** Statuses that never hold the switch back, whatever the item: an older but supported rendering still runs. */
export const ACTIONS_SETUP_PASSING_STATUSES: readonly ActionsSetupStatus[] = Object.freeze(['ok', 'outdated']);

/**
 * The console's pull request on its own head branch. `foreign`: someone else opened a PR from that branch (or in
 * another repository); `changed`: the PR is the console's, but it now holds other commits, files or bytes. The page
 * never tells the customer to merge a PR that is not `console`.
 */
export const ACTIONS_SETUP_PR_PROVENANCES = ['console', 'foreign', 'changed'] as const;
export type ActionsSetupPrProvenance = (typeof ACTIONS_SETUP_PR_PROVENANCES)[number];

export interface ActionsSetupPrDto {
  readonly number: number;
  /** GitHub's `html_url` of the PR; always `https://github.com/…`. */
  readonly url: string;
  readonly provenance: ActionsSetupPrProvenance;
  /**
   * #870: the PR is from the branch of an earlier rendering, not this console's current one; present only then. A
   * stale PR is `console` only when its file is an earlier rendering of the console's own template.
   */
  readonly stale?: true;
}

export interface ActionsSetupItemDto {
  readonly id: ActionsSetupItemId;
  readonly status: ActionsSetupStatus;
  /** Where on GitHub to fix it; always `https://github.com/…`, never a console path. */
  readonly link?: string;
  /** On the `workflow` item only, when a PR is open from the console's head branch. */
  readonly pr?: ActionsSetupPrDto;
}

/** The three versions a runner workflow pins (#870), as the rendering names them. */
export interface ActionsWorkflowPinsDto {
  readonly runner: string;
  readonly node: string;
  readonly claudeCode: string;
}

/** The pins read from the file on the default branch: `null` for a pin not found exactly once as `NAME: x.y.z`. */
export type ActionsWorkflowReadPinsDto = { readonly [K in keyof ActionsWorkflowPinsDto]: string | null };

/**
 * The file's `RUNNER_VERSION` against the environment's `RUNNER_MINIMUM_VERSION` (#464, judged by
 * `isRunnerVersionBelow`). `unknown`: no file was read, or it names no runner version the console could read.
 */
export const ACTIONS_RUNNER_SUPPORTS = ['supported', 'unsupported', 'unknown'] as const;
export type ActionsRunnerSupport = (typeof ACTIONS_RUNNER_SUPPORTS)[number];

export interface ActionsSetupVersionsDto {
  /** This console's rendering. */
  readonly expected: ActionsWorkflowPinsDto;
  /** The file on the default branch; `null` when there is none or it was not read. */
  readonly current: ActionsWorkflowReadPinsDto | null;
  /** The environment's `RUNNER_MINIMUM_VERSION`; `null` when it is unset (then no version is below it). */
  readonly minRunner: string | null;
  /** The file's runner against `minRunner`. */
  readonly runnerSupport: ActionsRunnerSupport;
}

export interface ActionsSetupDto {
  readonly dispatch: ProjectDispatch;
  readonly accessSource: AccessSource;
  /** Every item `ok` or `outdated`, the advisory ones aside: what `PUT …/dispatch {actions}` requires. */
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly items: readonly ActionsSetupItemDto[];
  /** #870: GitHub's `default_branch` as this check read it; `null` when the repository was not read. */
  readonly defaultBranch: string | null;
  /**
   * #870: whether `POST …/workflow-pr` may write right now (`ALLOW_ACTIONS_SETUP_WRITE` and no operator stop), so the
   * page leads with the Copy path before a click meets 503 `github-write-disabled`. Availability only: the route
   * judges it again on every click.
   */
  readonly workflowPr: 'enabled' | 'disabled';
  readonly versions: ActionsSetupVersionsDto;
}

/**
 * `POST /api/v1/projects/:slug/actions-setup/workflow-pr` (#759 PR 4): the pull request the console opened in the
 * project's repository with its rendering of the runner workflow. The server decides the kind from the file on the
 * default branch: `setup` when there is none, `bump` when the file pins an older runner, Node.js or Claude Code
 * version, `restore` when it differs in any other way. The console never merges the pull request.
 */
export const ACTIONS_WORKFLOW_PR_KINDS = ['setup', 'bump', 'restore'] as const;
export type ActionsWorkflowPrKind = (typeof ACTIONS_WORKFLOW_PR_KINDS)[number];

export interface ActionsWorkflowPrDto {
  readonly number: number;
  /** GitHub's `html_url` of the pull request; always `https://github.com/…`. */
  readonly url: string;
  readonly kind: ActionsWorkflowPrKind;
}

export function isActionsWorkflowPrDto(value: unknown): value is ActionsWorkflowPrDto {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return false;
  }
  const { number, url, kind } = value;
  return (
    Number.isSafeInteger(number) &&
    (number as number) > 0 &&
    isGitHubUiUrl(url) &&
    (ACTIONS_WORKFLOW_PR_KINDS as readonly unknown[]).includes(kind)
  );
}

/**
 * The route's own refusals, as problem types (it also answers the setup routes' `console-origin-misconfigured`,
 * `dispatch-repository-unverified` and `rate-limited`). `actions-setup-pr-open` (409) carries `extensions.number`, `url` and
 * `provenance` of the open pull request; `actions-permission-missing` (422) names the missing app permissions in
 * `extensions.permissions`; `actions-setup-downgrade` (422) names the pins the console's file would lower in
 * `extensions.pins`. `github-write-disabled` (503) is the operator's kill switch: the Copy path stays.
 */
export const ACTIONS_WORKFLOW_PR_REFUSALS = [
  'actions-setup-pr-open',
  'actions-setup-branch-exists',
  'actions-setup-pr-tampered',
  'actions-permission-missing',
  'actions-setup-ready',
  'actions-setup-downgrade',
  'github-write-disabled',
] as const;
export type ActionsWorkflowPrRefusal = (typeof ACTIONS_WORKFLOW_PR_REFUSALS)[number];

/** 422 `actions-not-ready` of `PUT …/dispatch {actions}`: `extensions.items` names the items that hold it back. */
export const ACTIONS_NOT_READY = 'actions-not-ready';

/** A GitHub UI address is short; anything far longer is not one the console hands out. */
const GITHUB_UI_URL_MAX_LENGTH = 2048;

/**
 * Every link the readiness answers points at GitHub's own UI (#870): parsed, `https:` on exactly `github.com` with no
 * port or userinfo, and spelled with that origin (the parser, not a prefix, judges the host). No quote, angle
 * bracket, backslash or whitespace either: the page puts the string into an attribute as it is.
 */
export function isGitHubUiUrl(value: unknown): value is string {
  if (!isString(value) || value.length > GITHUB_UI_URL_MAX_LENGTH || /[\s"'<>\\]/.test(value) || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.origin === 'https://github.com' &&
    value.startsWith('https://github.com/')
  );
}

/** The items that hold the switch back: neither ok nor outdated, and not advisory. */
export function blockingItemsOf(items: readonly ActionsSetupItemDto[]): ActionsSetupItemId[] {
  return items
    .filter((item) => !ACTIONS_SETUP_PASSING_STATUSES.includes(item.status) && !ACTIONS_SETUP_ADVISORY_ITEMS.includes(item.id))
    .map((item) => item.id);
}

/**
 * Why "Needs you" lists an Actions project's workflow (#874), from the last stored judgement of the file (migration
 * 0041). `missing`, `outdated`, `unsupported` and `modified` are the readiness check's own words: the file is gone,
 * pins an older release, pins a runner below the minimum, or is not the console's bytes. `release`: the file was the
 * console's rendering when checked, but this console renders another one since (a release or a config change), so
 * it is behind until a check says otherwise. `ok` and `unknown` are no drift: `unknown` is a permission the page
 * itself asks for.
 */
export const ACTIONS_DRIFT_STATUSES = [
  'missing',
  'outdated',
  'unsupported',
  'modified',
] as const satisfies readonly ActionsSetupStatus[];
export type ActionsDriftStatus = (typeof ACTIONS_DRIFT_STATUSES)[number];
export const isActionsDriftStatus = (value: unknown): value is ActionsDriftStatus =>
  (ACTIONS_DRIFT_STATUSES as readonly unknown[]).includes(value);

export const NEEDS_YOU_ACTIONS_DRIFTS = [...ACTIONS_DRIFT_STATUSES, 'release'] as const;
export type NeedsYouActionsDrift = (typeof NEEDS_YOU_ACTIONS_DRIFTS)[number];

export interface NeedsYouActionsDriftDto {
  readonly drift: NeedsYouActionsDrift;
  /** When the stored judgement was made: the row can be stale, so the console says when it was checked. */
  readonly checkedAt: string;
}

export function isNeedsYouActionsDriftDto(value: unknown): value is NeedsYouActionsDriftDto {
  if (!isRecord(value) || !hasExactKeys(value, ['drift', 'checkedAt'])) {
    return false;
  }
  const { drift, checkedAt } = value;
  return (
    (NEEDS_YOU_ACTIONS_DRIFTS as readonly unknown[]).includes(drift) &&
    isString(checkedAt) &&
    !Number.isNaN(Date.parse(checkedAt))
  );
}

const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const isVersion = (value: unknown): value is string => isString(value) && VERSION.test(value);
const PIN_KEYS = ['runner', 'node', 'claudeCode'] as const;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isPins(value: unknown, nullable: boolean): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, PIN_KEYS) &&
    PIN_KEYS.every((key) => isVersion(value[key]) || (nullable && value[key] === null))
  );
}

function isActionsSetupVersionsDto(value: unknown): value is ActionsSetupVersionsDto {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['expected', 'current', 'minRunner', 'runnerSupport']) &&
    isPins(value['expected'], false) &&
    (value['current'] === null || isPins(value['current'], true)) &&
    (value['minRunner'] === null || isRunnerVersion(value['minRunner'])) &&
    (ACTIONS_RUNNER_SUPPORTS as readonly unknown[]).includes(value['runnerSupport'])
  );
}

function isActionsSetupPrDto(value: unknown): value is ActionsSetupPrDto {
  if (!isRecord(value)) {
    return false;
  }
  const { number, url, provenance, stale } = value;
  const keys = stale === true ? ['number', 'url', 'provenance', 'stale'] : ['number', 'url', 'provenance'];
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  return (
    Number.isSafeInteger(number) &&
    (number as number) > 0 &&
    isGitHubUiUrl(url) &&
    (ACTIONS_SETUP_PR_PROVENANCES as readonly unknown[]).includes(provenance)
  );
}

function isActionsSetupItemDto(value: unknown): value is ActionsSetupItemDto {
  if (!isRecord(value)) {
    return false;
  }
  const allowed = new Set(['id', 'status', 'link', 'pr']);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    return false;
  }
  return (
    isActionsSetupItemId(value['id']) &&
    isActionsSetupStatus(value['status']) &&
    (value['link'] === undefined || isGitHubUiUrl(value['link'])) &&
    (value['pr'] === undefined || (value['id'] === 'workflow' && isActionsSetupPrDto(value['pr'])))
  );
}

/** The readiness answer's keys, exactly (#870 added the last three). */
export const ACTIONS_SETUP_DTO_KEYS = [
  'dispatch',
  'accessSource',
  'ready',
  'checkedAt',
  'items',
  'defaultBranch',
  'workflowPr',
  'versions',
] as const;

/** The answer's exact key set: no names, dates, lengths or reviewer identities can ride along. */
export function isActionsSetupDto(value: unknown): value is ActionsSetupDto {
  if (!isRecord(value) || !hasExactKeys(value, ACTIONS_SETUP_DTO_KEYS)) {
    return false;
  }
  const { dispatch, accessSource, ready, checkedAt, items, defaultBranch, workflowPr, versions } = value;
  if (
    (defaultBranch !== null && (!isString(defaultBranch) || defaultBranch === '')) ||
    (workflowPr !== 'enabled' && workflowPr !== 'disabled') ||
    !isActionsSetupVersionsDto(versions) ||
    !isProjectDispatch(dispatch) ||
    !isAccessSource(accessSource) ||
    typeof ready !== 'boolean' ||
    !isString(checkedAt) ||
    Number.isNaN(Date.parse(checkedAt)) ||
    !Array.isArray(items) ||
    !items.every(isActionsSetupItemDto)
  ) {
    return false;
  }
  const ids = items.map((item: ActionsSetupItemDto) => item.id);
  return (
    ids.length === ACTIONS_SETUP_ITEMS.length &&
    ids.every((id, index) => id === ACTIONS_SETUP_ITEMS[index]) &&
    ready === (blockingItemsOf(items as ActionsSetupItemDto[]).length === 0)
  );
}
