import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  ACTIONS_ENVIRONMENT,
  ACTIONS_OIDC_ISSUER,
  ACTIONS_RUN_ID,
  ACTIONS_WORKFLOW_FILE,
  OIDC_TOKEN_MAX_AGE,
  runnerAudienceOf,
  type OidcExchangeClaim,
} from '@shared/contracts';
import type { ApiEnv } from '../env';

/**
 * GitHub Actions OIDC tokens (#668; ADR 0008 decision 7(a′), threat model C11 row 5). A workflow run's token is the
 * only credential of `POST /runner/oidc-exchange`: RS256 by a key of GitHub's issuer JWKS, `iss` GitHub's, `aud` this
 * environment's runner audience, inside its lifetime (30 s tolerance). Then every claim that ties the run to the
 * project is compared with the project's row, so a token of another repository, branch, workflow, event, Environment
 * or a self-hosted runner never becomes a runner identity.
 */

const JWKS_URL = new URL(`${ACTIONS_OIDC_ISSUER}/.well-known/jwks`);
const CLOCK_TOLERANCE_SECONDS = 30;

// One remote set per isolate: jose caches the keys and refetches on an unknown `kid` (with a cooldown).
let remoteJwks: JWTVerifyGetKey | undefined;
let localJwks: { readonly json: string; readonly keys: JWTVerifyGetKey } | undefined;

/** Where the keys come from: GitHub's JWKS, or — on `ENVIRONMENT = local` only — the test JWKS of `ACTIONS_OIDC_JWKS`. */
export type ActionsJwksSource = { readonly kind: 'remote' } | { readonly kind: 'local'; readonly json: string };

export function actionsJwksSourceOf(env: Pick<ApiEnv, 'ENVIRONMENT' | 'ACTIONS_OIDC_JWKS'>): ActionsJwksSource {
  const json = env.ACTIONS_OIDC_JWKS?.trim() ?? '';
  return env.ENVIRONMENT === 'local' && json !== '' ? { kind: 'local', json } : { kind: 'remote' };
}

class InvalidJwksError extends Error {
  constructor() {
    super('ACTIONS_OIDC_JWKS is not a JSON Web Key Set');
    this.name = 'InvalidJwksError';
  }
}

function isJwks(value: unknown): value is JSONWebKeySet {
  return typeof value === 'object' && value !== null && Array.isArray((value as { keys?: unknown }).keys);
}

function jwksOf(source: ActionsJwksSource): JWTVerifyGetKey {
  if (source.kind === 'remote') {
    remoteJwks ??= createRemoteJWKSet(JWKS_URL);
    return remoteJwks;
  }
  if (localJwks?.json !== source.json) {
    const parsed: unknown = JSON.parse(source.json);
    if (!isJwks(parsed)) {
      throw new InvalidJwksError();
    }
    localJwks = { json: source.json, keys: createLocalJWKSet(parsed) };
  }
  return localJwks.keys;
}

export type OidcVerification =
  | { readonly ok: true; readonly claims: JWTPayload }
  | { readonly ok: false; readonly claim: OidcExchangeClaim }
  /** GitHub's JWKS could not be read: not the token's fault, so not a refusal of it. */
  | { readonly ok: false; readonly claim: null };

/** Signature, issuer, audience and lifetime. Nothing of the token is returned on a refusal, nor logged here. */
export async function verifyActionsOidcToken(
  env: Pick<ApiEnv, 'ENVIRONMENT' | 'ACTIONS_OIDC_JWKS'>,
  token: string,
  now: Date = new Date(),
): Promise<OidcVerification> {
  try {
    // Shape first, so a malformed value never reaches the key set (and never triggers a fetch).
    decodeProtectedHeader(token);
    decodeJwt(token);
  } catch (error: unknown) {
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      return { ok: false, claim: 'token' };
    }
    throw error;
  }
  let keys: JWTVerifyGetKey;
  try {
    keys = jwksOf(actionsJwksSourceOf(env));
  } catch (error: unknown) {
    // Only the local override can fail here (its JSON); a broken stand-in is the stack's fault, not the token's.
    if (error instanceof SyntaxError || error instanceof joseErrors.JOSEError || error instanceof InvalidJwksError) {
      return { ok: false, claim: null };
    }
    throw error;
  }
  let issuerUnavailable = false;
  const getKey: JWTVerifyGetKey = async (header, input) => {
    try {
      return await keys(header, input);
    } catch (error: unknown) {
      // A `kid` the set does not hold is the token's fault; anything else is the issuer's (timeout, bad answer).
      if (!(error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSMultipleMatchingKeys)) {
        issuerUnavailable = true;
      }
      throw error;
    }
  };
  try {
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ['RS256'],
      issuer: ACTIONS_OIDC_ISSUER,
      audience: runnerAudienceOf(env.ENVIRONMENT),
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      requiredClaims: ['iss', 'aud', 'exp', 'iat'],
      // #695: bounds `iat` too — never ahead of the clock (past the tolerance), never older than the limit.
      maxTokenAge: OIDC_TOKEN_MAX_AGE,
    });
    return { ok: true, claims: payload };
  } catch (error: unknown) {
    if (issuerUnavailable) {
      return { ok: false, claim: null };
    }
    // jose reports a token past `maxTokenAge` as JWTExpired on `iat`, and one issued in the future as `iat` failed.
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, claim: error.claim === 'iat' ? 'iat' : 'exp' };
    }
    if (error instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = error.claim;
      return { ok: false, claim: claim === 'iss' || claim === 'aud' || claim === 'exp' || claim === 'iat' ? claim : 'token' };
    }
    if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
      return { ok: false, claim: 'token' };
    }
    throw error;
  }
}

/** What a run's claims are compared with: the project the job belongs to, as D1 holds it. */
export interface ActionsTarget {
  /** `projects.repo_id`; `null` (never recorded) matches no token. */
  readonly repoId: number | null;
  /** `owner/name` as registered. */
  readonly repo: string;
  /** `projects.default_branch`; `null` matches no token: the console dispatches only on the default branch. */
  readonly defaultBranch: string | null;
}

const WORKFLOW_PATH = `/.github/workflows/${ACTIONS_WORKFLOW_FILE}@`;

/** `owner/name/.github/workflows/team-console-runner.yml@refs/heads/<branch>`, the owner/name part in any case. */
function isRunnerWorkflowRef(value: unknown, target: ActionsTarget, ref: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const at = value.indexOf(WORKFLOW_PATH);
  // GitHub keeps the repository's casing, the registry the owner's: names are case-insensitive, the path and ref not.
  return at > 0 && value.slice(0, at).toLowerCase() === target.repo.toLowerCase() && value.slice(at + WORKFLOW_PATH.length) === ref;
}

/**
 * The first claim that does not tie this run to the target, in the order of the table in the architect note on #573:
 * `null` when all hold. `run_id` is checked for shape here; "never seen before" is the exchange's own D1 check.
 */
export function actionsClaimRefusalOf(claims: JWTPayload, target: ActionsTarget): OidcExchangeClaim | null {
  if (!isTargetRepository(claims, target)) {
    return 'repository_id';
  }
  const ref = target.defaultBranch === null ? null : `refs/heads/${target.defaultBranch}`;
  if (ref === null || claims['ref'] !== ref) {
    return 'ref';
  }
  if (claims['ref_type'] !== 'branch') {
    return 'ref_type';
  }
  if (!isRunnerWorkflowRef(claims['workflow_ref'], target, ref)) {
    return 'workflow_ref';
  }
  // The same file as `workflow_ref`: the job runs in the runner workflow itself, never in a reusable workflow it calls.
  if (!isRunnerWorkflowRef(claims['job_workflow_ref'], target, ref)) {
    return 'job_workflow_ref';
  }
  if (claims['event_name'] !== 'workflow_dispatch') {
    return 'event_name';
  }
  // The Environment with the default-branch policy holds the key; a job outside it never reaches the exchange.
  if (claims['environment'] !== ACTIONS_ENVIRONMENT) {
    return 'environment';
  }
  // Owner decision 2 on #573: only a VM GitHub discards after the job admits `actions-ephemeral`.
  if (claims['runner_environment'] !== 'github-hosted') {
    return 'runner_environment';
  }
  const runId = claims['run_id'];
  if (typeof runId !== 'string' || !ACTIONS_RUN_ID.test(runId)) {
    return 'run_id';
  }
  return null;
}

/** The token names the repository the target's project is registered with (`repository_id`, the first claim checked). */
export function isTargetRepository(claims: JWTPayload, target: ActionsTarget): boolean {
  return target.repoId !== null && claims['repository_id'] === String(target.repoId);
}

/** The verified `repository_id`, the key of the per-repository rate limit; `null` when the token has none usable. */
export function repositoryIdOf(claims: JWTPayload): string | null {
  const value = claims['repository_id'];
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}
