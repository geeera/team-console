/**
 * Secret shapes that must never be stored as text a job wrote (#462, ADR 0008 row 2-0) nor reach a log line or an
 * audit row (#467): the one pattern list the API's 422 `body-secret` check, the Worker logger (`@worker/core`
 * `redact`), `AuditRepo` and the runner's event redactor share, so none of them drifts from the others.
 *
 * Two strictness modes:
 * - `strict` (the default; `findSecret`): the whole shape of a token, so prose that merely names a prefix
 *   (`ghs_ and glpat-`) is not refused as a secret.
 * - `loose` (logs and audit rows): the prefix with whatever tail follows, so a credential cut off by an error
 *   message, a truncation or a quote is still masked. Over-masking a log costs a display value, never a secret.
 *
 * No pattern backtracks over the text: each starts at a fixed prefix, has no nested quantifier, and every quantifier
 * that a failed attempt could run to the end of the text is bounded, so a 64 KB body stays cheap to scan. The JWT
 * pattern alone carries a prefix guard (#474 re-review): `eyJ` inside a base64url run is not a JWT start, so a 64 KB
 * run of `eyJ…` is scanned once instead of once per character.
 *
 * No word-boundary anchors (#474 review): a token glued to a word (`token<ghp_…>`, `GH_TOKEN_<ghp_…>`, `<ghp_…>_x`)
 * is still a token. The distinctive prefix and the long tail are the anchor; a longer run is still a match (fail
 * closed). Out of reach of any pattern, and so not the boundary (RR11): base64- or percent-encoded tokens, a token
 * split by visible characters or across two fields, and prefix-less credentials (Cloudflare API tokens).
 */

export type SecretKind =
  | 'github-token'
  | 'gitlab-token'
  | 'jwt'
  | 'private-key'
  | 'job-token'
  | 'enrolment-code'
  | 'anthropic-key'
  | 'npm-token'
  | 'aws-access-key';

export type RedactionMode = 'strict' | 'loose';

/**
 * The console's job token (ADR 0008 decision 1, minted by 2-A's claim): this prefix and 43 base64url characters
 * (256 random bits).
 */
export const JOB_TOKEN_PREFIX = 'tcj_';
/** A runner enrolment code (ADR 0006 "Enrolment", 2-A): the same shape under its own prefix. */
export const ENROLMENT_CODE_PREFIX = 'tce_';
/** The characters of the random part of a job token or an enrolment code, and how many: base64url of 32 bytes. */
export const OPAQUE_TOKEN_TAIL = String.raw`[A-Za-z0-9_-]{43}`;

interface SecretPattern {
  readonly kind: SecretKind;
  readonly strict: string;
  /** The log-grade shape; the strict one when a looser shape would mask ordinary words (`npm_config_cache`). */
  readonly loose: string;
}

const B64URL = String.raw`[A-Za-z0-9_-]`;
// Not preceded by a base64url character: `eyJ` inside a run is a continuation, not a header start.
const JWT_GUARD = String.raw`(?<!${B64URL})`;
const PEM_BLOCK = String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)`;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // GitHub: classic PAT, OAuth, user-to-server, installation (`ghs_`, what a job's GitHub token is) and refresh tokens.
  {
    kind: 'github-token',
    strict: String.raw`gh[pousr]_[A-Za-z0-9]{36,255}`,
    loose: String.raw`gh[pousr]_[A-Za-z0-9_]{1,255}`,
  },
  // GitHub fine-grained PAT.
  {
    kind: 'github-token',
    strict: String.raw`github_pat_[A-Za-z0-9_]{22,255}`,
    loose: String.raw`github_pat_[A-Za-z0-9_]{1,255}`,
  },
  {
    kind: 'gitlab-token',
    strict: String.raw`glpat-[A-Za-z0-9_.-]{20,255}`,
    loose: String.raw`glpat-[A-Za-z0-9_.-]{1,255}`,
  },
  // A JWS: base64url header and payload of JSON objects (`{"` encodes as `eyJ`), then the signature (empty for
  // `none`). Header and payload are bounded: a failed attempt (no dot) then costs at most the bound, never the rest
  // of the text. Loose: the payload may be anything base64url (a cut or hand-built token in an error message).
  {
    kind: 'jwt',
    strict: String.raw`${JWT_GUARD}eyJ${B64URL}{5,1024}\.eyJ${B64URL}{5,16384}\.${B64URL}*`,
    loose: String.raw`${JWT_GUARD}eyJ${B64URL}{1,1024}\.${B64URL}{1,16384}\.${B64URL}*`,
  },
  // A PEM private key of any type (RSA, EC, OPENSSH, ENCRYPTED, …) or an armored PGP private key block, up to its
  // END line or the end of the text. Loose also masks the bare phrase: a log line that quotes an armor header cut
  // short of its dashes still carries nothing of the key.
  { kind: 'private-key', strict: PEM_BLOCK, loose: String.raw`${PEM_BLOCK}|PRIVATE KEY` },
  {
    kind: 'job-token',
    strict: String.raw`${JOB_TOKEN_PREFIX}${OPAQUE_TOKEN_TAIL}`,
    loose: String.raw`${JOB_TOKEN_PREFIX}${B64URL}{1,255}`,
  },
  // The token as the job's environment names it, whatever its value looks like.
  {
    kind: 'job-token',
    strict: String.raw`TC_JOB_TOKEN[ \t]*[=:][ \t]*["']?[^\s"']{8,}`,
    loose: String.raw`TC_JOB_TOKEN[ \t]*[=:][ \t]*["']?[^\s"']{1,}`,
  },
  {
    kind: 'enrolment-code',
    strict: String.raw`${ENROLMENT_CODE_PREFIX}${OPAQUE_TOKEN_TAIL}`,
    loose: String.raw`${ENROLMENT_CODE_PREFIX}${B64URL}{1,255}`,
  },
  // An Anthropic API key (ADR 0008 decision 7: the customer's own key in hosted mode); also the routine trigger
  // tokens of #114 (`sk-ant-oat01-…`), whole or cut off in a log.
  {
    kind: 'anthropic-key',
    strict: String.raw`sk-ant-[A-Za-z0-9_-]{20,}`,
    loose: String.raw`sk-ant-[A-Za-z0-9_-]{1,}`,
  },
  // An npm automation or publish token. The same in both modes: `npm_config_cache` is a word, not a token.
  { kind: 'npm-token', strict: String.raw`npm_[A-Za-z0-9]{36}`, loose: String.raw`npm_[A-Za-z0-9]{36}` },
  // An AWS access key id, long-lived (`AKIA`) or temporary (`ASIA`); fixed length, so the same in both modes.
  {
    kind: 'aws-access-key',
    strict: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
    loose: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
  },
];

/** The prefixes the list recognises, for the sentinel specs that prove every one of them is masked. */
export const SECRET_KINDS: readonly SecretKind[] = [...new Set(SECRET_PATTERNS.map(({ kind }) => kind))];

const STRICT_TESTERS: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = SECRET_PATTERNS.map(
  ({ kind, strict }) => ({ kind, pattern: new RegExp(strict) }),
);

/**
 * The kind of the first secret shape found in `text` (in pattern order), or `null` when there is none. Strict only:
 * this is what refuses a job's text, so a mere prefix in prose must pass.
 */
export function findSecret(text: string): SecretKind | null {
  return STRICT_TESTERS.find(({ pattern }) => pattern.test(text))?.kind ?? null;
}

/**
 * `text` with every secret shape replaced by `[redacted:<kind>]`; the rest of the text is kept as it is. `loose`
 * is the log-grade mode (see the header); `strict` the default.
 */
export function redactSecrets(text: string, mode: RedactionMode = 'strict'): string {
  // A fresh global RegExp per call: a shared one would carry `lastIndex` from one call into the next.
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(new RegExp(pattern[mode], 'g'), `[redacted:${pattern.kind}]`),
    text,
  );
}
