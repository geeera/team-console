/**
 * Secret shapes that must never be stored as text a job wrote (#462, ADR 0008 row 2-0): the API refuses a job's item
 * or comment text that carries one (422 `body-secret`), and the runner's event redactor masks them before an event
 * leaves the machine. One list, so the two never drift apart.
 *
 * No pattern backtracks over the text: each starts at a fixed prefix, has no nested quantifier, and every quantifier
 * that a failed attempt could run to the end of the text is bounded, so a 64 KB body stays cheap to scan.
 */

export type SecretKind =
  'github-token' | 'gitlab-token' | 'jwt' | 'private-key' | 'job-token' | 'anthropic-key';

/**
 * The console's job token (ADR 0008 decision 1, issued by 2-A): this prefix and 43 base64url characters (256 random
 * bits). Fixed here so a leaked token is recognisable before the minter exists.
 */
export const JOB_TOKEN_PREFIX = 'tcj_';

interface SecretPattern {
  readonly kind: SecretKind;
  readonly source: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // GitHub: classic PAT, OAuth, user-to-server, installation (`ghs_`, what a job's GitHub token is) and refresh tokens.
  { kind: 'github-token', source: String.raw`\bgh[pousr]_[A-Za-z0-9]{36,255}\b` },
  // GitHub fine-grained PAT.
  { kind: 'github-token', source: String.raw`\bgithub_pat_[A-Za-z0-9_]{22,255}` },
  { kind: 'gitlab-token', source: String.raw`\bglpat-[A-Za-z0-9_.-]{20,255}` },
  // A JWS: base64url header and payload of JSON objects (`{"` encodes as `eyJ`), then the signature (empty for `none`).
  // Header and payload are bounded: a failed attempt (no dot) then costs at most the bound, never the rest of the text.
  { kind: 'jwt', source: String.raw`\beyJ[A-Za-z0-9_-]{5,1024}\.eyJ[A-Za-z0-9_-]{5,16384}\.[A-Za-z0-9_-]*` },
  // A PEM private key of any type (RSA, EC, OPENSSH, ENCRYPTED, …), up to its END line or the end of the text.
  {
    kind: 'private-key',
    source: String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)`,
  },
  { kind: 'job-token', source: String.raw`\b${JOB_TOKEN_PREFIX}[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])` },
  // The token as the job's environment names it, whatever its value looks like.
  { kind: 'job-token', source: String.raw`\bTC_JOB_TOKEN[ \t]*[=:][ \t]*["']?[^\s"']{8,}` },
  // An Anthropic API key (ADR 0008 decision 7: the customer's own key in hosted mode).
  { kind: 'anthropic-key', source: String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}` },
];

const TESTERS: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = SECRET_PATTERNS.map(
  ({ kind, source }) => ({ kind, pattern: new RegExp(source) }),
);

/** The kind of the first secret shape found in `text` (in pattern order), or `null` when there is none. */
export function findSecret(text: string): SecretKind | null {
  return TESTERS.find(({ pattern }) => pattern.test(text))?.kind ?? null;
}

/** `text` with every secret shape replaced by `[redacted:<kind>]`; the rest of the text is kept as it is. */
export function redactSecrets(text: string): string {
  // A fresh global RegExp per call: a shared one would carry `lastIndex` from one call into the next.
  return SECRET_PATTERNS.reduce(
    (result, { kind, source }) => result.replace(new RegExp(source, 'g'), `[redacted:${kind}]`),
    text,
  );
}
