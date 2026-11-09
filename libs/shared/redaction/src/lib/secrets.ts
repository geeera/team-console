/**
 * Secret shapes that must never be stored as text a job wrote (#462, ADR 0008 row 2-0): the API refuses a job's item
 * or comment text that carries one (422 `body-secret`), and the runner's event redactor masks them before an event
 * leaves the machine. One list, so the two never drift apart.
 *
 * No pattern backtracks over the text: each starts at a fixed prefix, has no nested quantifier, and every quantifier
 * that a failed attempt could run to the end of the text is bounded, so a 64 KB body stays cheap to scan.
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
  | 'anthropic-key'
  | 'npm-token'
  | 'aws-access-key';

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
  { kind: 'github-token', source: String.raw`gh[pousr]_[A-Za-z0-9]{36,255}` },
  // GitHub fine-grained PAT.
  { kind: 'github-token', source: String.raw`github_pat_[A-Za-z0-9_]{22,255}` },
  { kind: 'gitlab-token', source: String.raw`glpat-[A-Za-z0-9_.-]{20,255}` },
  // A JWS: base64url header and payload of JSON objects (`{"` encodes as `eyJ`), then the signature (empty for `none`).
  // Header and payload are bounded: a failed attempt (no dot) then costs at most the bound, never the rest of the text.
  { kind: 'jwt', source: String.raw`eyJ[A-Za-z0-9_-]{5,1024}\.eyJ[A-Za-z0-9_-]{5,16384}\.[A-Za-z0-9_-]*` },
  // A PEM private key of any type (RSA, EC, OPENSSH, ENCRYPTED, …) or an armored PGP private key block, up to its
  // END line or the end of the text.
  {
    kind: 'private-key',
    source: String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)`,
  },
  { kind: 'job-token', source: String.raw`${JOB_TOKEN_PREFIX}[A-Za-z0-9_-]{43}` },
  // The token as the job's environment names it, whatever its value looks like.
  { kind: 'job-token', source: String.raw`TC_JOB_TOKEN[ \t]*[=:][ \t]*["']?[^\s"']{8,}` },
  // An Anthropic API key (ADR 0008 decision 7: the customer's own key in hosted mode).
  { kind: 'anthropic-key', source: String.raw`sk-ant-[A-Za-z0-9_-]{20,}` },
  // An npm automation or publish token.
  { kind: 'npm-token', source: String.raw`npm_[A-Za-z0-9]{36}` },
  // An AWS access key id, long-lived (`AKIA`) or temporary (`ASIA`).
  { kind: 'aws-access-key', source: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}` },
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
