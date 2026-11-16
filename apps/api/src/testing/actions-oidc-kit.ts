import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from 'jose';
import { env } from 'cloudflare:test';
import {
  ACTIONS_ENVIRONMENT,
  ACTIONS_OIDC_ISSUER,
  ACTIONS_WORKFLOW_FILE,
  OWNER_ACCOUNT_ID,
  TEAM_CONFIG_SCHEMA,
  roleOfJobKind,
  runnerAudienceOf,
  type AccessSource,
  type Ed25519PublicJwk,
  type OidcExchangeInput,
} from '@shared/contracts';
import { newUlid } from '@worker/core';
import { TeamConfigRepo } from '@worker/db';
import type { ApiEnv } from '../env';
import { fetchApi } from './access-kit';
import { localEnv } from './github-kit';
import { generateRunnerKey } from './runner-kit';

/**
 * Test-only kit for the GitHub Actions OIDC exchange (#668): an RS256 issuer key of this run only, published to the
 * Worker as the local JWKS override (`ACTIONS_OIDC_JWKS`, honoured on ENVIRONMENT=local alone), tokens with the claims
 * GitHub puts in a `workflow_dispatch` run of the runner workflow, and projects and jobs shaped for Actions dispatch.
 * No real GitHub token or key is ever read.
 */

export interface TestIssuer {
  readonly privateKey: CryptoKey | KeyObject;
  readonly kid: string;
  /** The bindings with the issuer's JWKS as the local override. */
  readonly bindings: ApiEnv;
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `test-${crypto.randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, kid, bindings: localEnv({ ACTIONS_OIDC_JWKS: JSON.stringify({ keys: [jwk] }) }) };
}

export interface ActionsProject {
  readonly slug: string;
  readonly accountId: string;
  readonly repoId: number;
  readonly repo: string;
  readonly defaultBranch: string;
}

let counter = 0;
let runCounter = 0;

/** A decimal run id no other case of this file uses. */
export function nextRunId(): string {
  runCounter += 1;
  return String(7_100_000_000 + runCounter * 7 + Math.floor(Math.random() * 7));
}

/**
 * A project with the repository id and default branch the exchange compares a run with; `recordRepoId: false` leaves
 * `repo_id` unset, as on a row registered before 0018 (the column is written once, by trigger).
 */
export async function seedActionsProject(
  accountId: string = OWNER_ACCOUNT_ID,
  options: { readonly recordRepoId?: boolean } = {},
): Promise<ActionsProject> {
  counter += 1;
  const slug = `ax${String(counter)}-${crypto.randomUUID().slice(0, 6)}`;
  const repo = `Acme-Org/${slug}`;
  const repoId = 880_000 + counter;
  await env.DB.prepare(
    `INSERT INTO projects (slug, repo, display_name, cache_epoch, added_at, account_id, repo_id, default_branch, dispatch)
     VALUES (?1, ?2, ?1, 0, '2026-11-10T00:00:00.000Z', ?3, ?4, 'main', 'actions')`,
  )
    .bind(slug, repo, accountId, options.recordRepoId === false ? null : repoId)
    .run();
  const project = { slug, accountId, repoId, repo, defaultBranch: 'main' };
  // ADR 0009 d.3: only an API-key project may be dispatched to Actions (0032 refuses its jobs otherwise).
  await saveAccessSource(project, 'api_key', 0);
  return project;
}

/** Saves revision `expectedRevision + 1` of the project's team configuration with `source`; returns the outcome kind. */
export async function saveAccessSource(project: ActionsProject, source: AccessSource, expectedRevision: number): Promise<string> {
  const at = new Date().toISOString();
  const outcome = await new TeamConfigRepo(env.DB).save({
    projectSlug: project.slug,
    expectedRevision,
    config: { schema: TEAM_CONFIG_SCHEMA, access: { source } },
    diff: [{ path: 'access.source', to: source }],
    reason: null,
    id: newUlid(),
    at,
    by: 'owner',
    audit: {
      accountId: project.accountId,
      at,
      actorKind: 'user',
      actor: 'owner',
      kind: 'team-config.changed',
      target: project.slug,
      details: { revision_from: expectedRevision, revision_to: expectedRevision + 1, paths: ['access.source'] },
    },
  });
  return outcome.kind;
}

export interface SeededJobOptions {
  /** `false`: queued but never dispatched by the console (#695 item 3: a hand-started run must not take it). */
  readonly dispatched?: boolean;
  readonly needsLocal?: boolean;
  readonly role?: string;
}

/**
 * A queued job of the project, dispatched to Actions unless `dispatch` says otherwise; an Actions job counts as
 * dispatched by the console (`dispatched_at` set) unless `options.dispatched` is `false`.
 */
export async function seedActionsJob(
  project: ActionsProject,
  dispatch: 'actions' | 'pull' = 'actions',
  options: SeededJobOptions = {},
): Promise<string> {
  const id = newUlid();
  const now = new Date().toISOString();
  const dispatchedAt = dispatch === 'actions' && options.dispatched !== false ? now : null;
  await env.DB.prepare(
    `INSERT INTO jobs (id, account_id, project_slug, kind, role, requested_by, created_at, dispatch, dispatched_at, needs_local)
     VALUES (?1, ?2, ?3, 'slot-dev', ?4, 'owner', ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      project.accountId,
      project.slug,
      options.role ?? roleOfJobKind('slot-dev', null),
      now,
      dispatch,
      dispatchedAt,
      options.needsLocal === true ? 1 : 0,
    )
    .run();
  return id;
}

/** The claims GitHub puts in the token of a `workflow_dispatch` run of the runner workflow on the default branch. */
export function runClaimsOf(project: ActionsProject, runId: string = nextRunId()): Record<string, unknown> {
  const ref = `refs/heads/${project.defaultBranch}`;
  const workflowRef = `${project.repo}/.github/workflows/${ACTIONS_WORKFLOW_FILE}@${ref}`;
  return {
    sub: `repo:${project.repo}:environment:${ACTIONS_ENVIRONMENT}`,
    repository: project.repo,
    repository_id: String(project.repoId),
    repository_owner: project.repo.split('/')[0],
    ref,
    ref_type: 'branch',
    sha: 'a'.repeat(40),
    workflow: 'team-console runner',
    workflow_ref: workflowRef,
    workflow_sha: 'b'.repeat(40),
    job_workflow_ref: workflowRef,
    job_workflow_sha: 'b'.repeat(40),
    event_name: 'workflow_dispatch',
    environment: ACTIONS_ENVIRONMENT,
    runner_environment: 'github-hosted',
    run_id: runId,
    run_number: '12',
    run_attempt: '1',
    actor: 'octocat',
  };
}

export interface TokenOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /** Seconds since the epoch; defaults to now. */
  readonly issuedAt?: number;
  /** Seconds after `issuedAt`; defaults to 300 (GitHub's tokens live minutes). */
  readonly lifetimeSeconds?: number;
  readonly algorithm?: string;
  readonly kid?: string;
  readonly omit?: readonly ('iss' | 'aud' | 'exp' | 'nbf')[];
}

/** A run's OIDC token signed by the test issuer, unless `options` bend it for a refusal case. */
export async function actionsToken(
  issuer: Pick<TestIssuer, 'privateKey' | 'kid'>,
  claims: Record<string, unknown>,
  options: TokenOptions = {},
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const omit = new Set(options.omit ?? []);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.algorithm ?? 'RS256', kid: options.kid ?? issuer.kid, typ: 'JWT' })
    .setIssuedAt(issuedAt)
    .setJti(crypto.randomUUID());
  if (!omit.has('nbf')) {
    jwt.setNotBefore(issuedAt - 5);
  }
  if (!omit.has('iss')) {
    jwt.setIssuer(options.issuer ?? ACTIONS_OIDC_ISSUER);
  }
  if (!omit.has('aud')) {
    jwt.setAudience(options.audience ?? runnerAudienceOf('local'));
  }
  if (!omit.has('exp')) {
    jwt.setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 300));
  }
  return jwt.sign(issuer.privateKey);
}

export interface ExchangeCase {
  readonly body: OidcExchangeInput;
  readonly privateKey: CryptoKey | KeyObject;
  readonly publicKeyJwk: Ed25519PublicJwk;
}

/** The body the runner sends: the token, the job, and a key the VM made in memory for this run. */
export async function exchangeBodyOf(idToken: string, jobId: string): Promise<ExchangeCase> {
  const key = await generateRunnerKey();
  return {
    body: {
      idToken,
      jobId,
      publicKey: key.publicKeyJwk,
      version: '0.4.0',
      host: { os: 'linux', arch: 'x64', hostname: 'fv-az123-456' },
    },
    ...key,
  };
}

let addressCounter = 0;

/** A source address of its own per call, so the per-address limit judges one case, not the whole file. */
export function uniqueAddress(): string {
  addressCounter += 1;
  return `10.68.${String(Math.floor(addressCounter / 256) % 256)}.${String(addressCounter % 256)}`;
}

/** `POST /api/v1/runner/oidc-exchange` as the runner in the VM sends it: no cookie, no bearer, no browser headers. */
export async function postExchange(
  body: unknown,
  bindings: ApiEnv,
  options: { readonly headers?: Record<string, string>; readonly logSink?: (line: string) => void } = {},
): Promise<Response> {
  return fetchApi('/api/v1/runner/oidc-exchange', bindings, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': uniqueAddress(), ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
  });
}
