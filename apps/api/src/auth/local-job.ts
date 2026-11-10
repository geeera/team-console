import { JOB_TOKEN_PREFIX } from '@shared/redaction';
import type { Identity } from './auth.types';
import { isJobRole } from './job-roles';

/**
 * The local job stand-in (#444, architect note on #436 §1): `Authorization: Bearer local-job.<base64url(JSON)>` with
 * exactly `{"role", "project_slug", "job_id", "items": [n…]}`. Unsigned on purpose — it exists only where the local
 * bypass already makes every caller the owner (`authMiddleware` honours it under `isLocalBypass` alone and refuses
 * it everywhere else), so it grants a job nothing the owner-mapped `local` identity could not do. It lets the
 * plugin's contract suite run as a role against `wrangler dev`; Phase 2's job-token middleware replaces it.
 */

export const LOCAL_JOB_PREFIX = 'local-job.';

const BEARER = /^Bearer[ ]+(\S+)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// A payload of 100 item numbers is far below this; anything longer is not a stand-in.
const MAX_TOKEN_LENGTH = 4096;
const MAX_ITEMS = 100;
const MAX_ITEM_NUMBER = 2_147_483_647;
// The registry's lookup rule (projects/lookup.ts).
const SLUG = /^[a-z0-9-]{1,40}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MEMBERS = ['items', 'job_id', 'project_slug', 'role'];

export type LocalJobIdentity = Extract<Identity, { kind: 'job' }>;

export type BearerOf =
  | { readonly kind: 'none' }
  /** Some other `Authorization` value; the stand-in's checks never look inside it. */
  | { readonly kind: 'other' }
  | { readonly kind: 'local-job'; readonly token: string }
  /** A `tcj_` job token of a claimed job (#467, `job-auth.ts`). */
  | { readonly kind: 'job-token'; readonly token: string };

/** What the `Authorization` header carries, without judging it. */
export function bearerOf(header: string | undefined): BearerOf {
  if (header === undefined || header.trim() === '') {
    return { kind: 'none' };
  }
  const token = BEARER.exec(header.trim())?.[1];
  if (token?.startsWith(LOCAL_JOB_PREFIX) === true) {
    return { kind: 'local-job', token };
  }
  return token?.startsWith(JOB_TOKEN_PREFIX) === true ? { kind: 'job-token', token } : { kind: 'other' };
}

function decodeBase64url(text: string): string | null {
  if (!BASE64URL.test(text)) {
    return null;
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error: unknown) {
    // atob throws a DOMException on input it cannot decode; that is a malformed token, nothing else.
    if (error instanceof Error || error instanceof DOMException) {
      return null;
    }
    throw error;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isItemNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ITEM_NUMBER;
}

/**
 * The job a stand-in token names, or `null` for anything that is not exactly the documented shape: an unknown
 * role, a slug or job id outside its pattern, an extra or missing member, more than 100 items. Never throws on
 * input; the caller answers `null` with a 401 and logs no part of the token.
 */
export function parseLocalJobToken(token: string): LocalJobIdentity | null {
  if (!token.startsWith(LOCAL_JOB_PREFIX) || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const text = decodeBase64url(token.slice(LOCAL_JOB_PREFIX.length));
  const payload: unknown = text === null ? undefined : parseJson(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== MEMBERS.join(',')) {
    return null;
  }
  const { role, project_slug: projectSlug, job_id: jobId, items } = record;
  if (
    !isJobRole(role) ||
    typeof projectSlug !== 'string' ||
    !SLUG.test(projectSlug) ||
    typeof jobId !== 'string' ||
    !JOB_ID.test(jobId) ||
    !Array.isArray(items) ||
    items.length > MAX_ITEMS ||
    !items.every(isItemNumber)
  ) {
    return null;
  }
  return { kind: 'job', role, projectSlug, jobId, items: [...new Set<number>(items)], source: 'stand-in' };
}
