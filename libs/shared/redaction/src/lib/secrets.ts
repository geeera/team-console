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
 *   Where a short tail is an ordinary word (`npm_config_cache`, `ghs_foo`), loose asks for a minimum tail instead.
 *
 * No pattern backtracks over the text: each starts at a fixed prefix, has no nested quantifier, and every quantifier
 * that a failed attempt could run to the end of the text is bounded, so a 64 KB body stays cheap to scan. JWTs are
 * found run by run (#474 re-review, #488 review): the text is split into runs of the JWT alphabet once, a run without
 * two dots is skipped, and inside a run the shape is tested at each `eyJ` close enough to the next dot for its header
 * bound (#492) — so a JWT glued to a preceding character (`%22<jwt>`, `token_<jwt>`) is still found while a 64 KB run
 * of `eyJ…`, with or without dots at its end, costs one pass. JWTs are masked before the prefix patterns (#492): a
 * loose prefix inside a segment (`…ghs_x.eyJ…`) would otherwise cut the JWT and leave the rest of it readable.
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
/** The shortest `gh[pousr]_` tail loose mode masks (#492): see the pattern below. */
const GITHUB_LOOSE_MIN = 12;
const PEM_BLOCK = String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)`;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // GitHub: classic PAT, OAuth, user-to-server, installation (`ghs_`, what a job's GitHub token is) and refresh tokens.
  // Their tail is 36+ base62 characters, the last 6 a checksum. Loose (#492) keeps that alphabet (no `_`) and asks for
  // GITHUB_LOOSE_MIN of it, so an identifier like `ghs_foo` or `ghs_rate_limit` stays readable, while a token cut
  // shorter than that leaves at least 19 of its 30 random characters (~110 bits) unseen.
  {
    kind: 'github-token',
    strict: String.raw`gh[pousr]_[A-Za-z0-9]{36,255}`,
    loose: String.raw`gh[pousr]_[A-Za-z0-9]{${GITHUB_LOOSE_MIN},255}`,
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

/** The bound on a JWT header after its `eyJ`, in both modes. */
const JWT_HEADER_MAX = 1024;
/**
 * A JWS: base64url header and payload of JSON objects (`{"` encodes as `eyJ`), then the signature (empty for `none`),
 * tested with a sticky RegExp at an `eyJ` inside a run. Header and payload are bounded: a failed attempt (no dot)
 * costs at most the bound. Loose: the payload may be anything base64url (a cut or hand-built token in a message).
 */
const JWT_SHAPE: Readonly<Record<RedactionMode, string>> = {
  strict: String.raw`eyJ${B64URL}{5,${JWT_HEADER_MAX}}\.eyJ${B64URL}{5,16384}\.${B64URL}*`,
  loose: String.raw`eyJ${B64URL}{1,${JWT_HEADER_MAX}}\.${B64URL}{1,16384}\.${B64URL}*`,
};
/** A run of the JWT alphabet; a JWT never crosses its edges, so each run is judged on its own. */
const JWT_RUN = /[A-Za-z0-9_.-]+/g;
const JWT_START = 'eyJ';

/** `[start, end)` of every JWT inside `run`, left to right, never overlapping. */
function jwtSpansOf(run: string, mode: RedactionMode): [number, number][] {
  // A JWT has two dots; most runs (words, ids, hashes) have none and cost one scan.
  if (run.indexOf('.') === -1 || run.indexOf('.', run.indexOf('.') + 1) === -1) {
    return [];
  }
  const shape = new RegExp(JWT_SHAPE[mode], 'y');
  const spans: [number, number][] = [];
  // An attempt at `at` needs the header's dot within the bound, so every `eyJ` further than that from the next dot
  // fails: skip to the first one in reach instead of trying each (#492), which keeps a run of `eyJ…` before a far
  // dot linear.
  const reach = JWT_START.length + JWT_HEADER_MAX;
  let nextDot = -1;
  let at = run.indexOf(JWT_START);
  while (at !== -1) {
    if (nextDot < at) {
      nextDot = run.indexOf('.', at);
      if (nextDot === -1) {
        break;
      }
    }
    if (nextDot - at > reach) {
      at = run.indexOf(JWT_START, nextDot - reach);
      continue;
    }
    shape.lastIndex = at;
    const match = shape.exec(run);
    if (match !== null) {
      spans.push([at, at + match[0].length]);
      at = run.indexOf(JWT_START, at + match[0].length);
    } else {
      at = run.indexOf(JWT_START, at + 1);
    }
  }
  return spans;
}

function hasJwt(text: string, mode: RedactionMode): boolean {
  for (const run of text.matchAll(JWT_RUN)) {
    if (jwtSpansOf(run[0], mode).length > 0) {
      return true;
    }
  }
  return false;
}

function maskJwts(text: string, mode: RedactionMode, mask: string): string {
  return text.replace(JWT_RUN, (run) => {
    const spans = jwtSpansOf(run, mode);
    if (spans.length === 0) {
      return run;
    }
    let result = '';
    let from = 0;
    for (const [start, end] of spans) {
      result += run.slice(from, start) + mask;
      from = end;
    }
    return result + run.slice(from);
  });
}

/** The kinds the list recognises, for the sentinel specs that prove every one of them is masked. */
export const SECRET_KINDS: readonly SecretKind[] = [
  ...new Set<SecretKind>([...SECRET_PATTERNS.map(({ kind }) => kind), 'jwt']),
];

const STRICT_TESTERS: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = SECRET_PATTERNS.map(
  ({ kind, strict }) => ({ kind, pattern: new RegExp(strict) }),
);

/**
 * The kind of the first secret shape found in `text` (in pattern order, JWTs last), or `null` when there is none.
 * Strict only: this is what refuses a job's text, so a mere prefix in prose must pass.
 */
export function findSecret(text: string): SecretKind | null {
  const kind = STRICT_TESTERS.find(({ pattern }) => pattern.test(text))?.kind;
  if (kind !== undefined) {
    return kind;
  }
  return hasJwt(text, 'strict') ? 'jwt' : null;
}

/**
 * `text` with every secret shape replaced by `[redacted:<kind>]`; the rest of the text is kept as it is. `loose`
 * is the log-grade mode (see the header); `strict` the default.
 */
export function redactSecrets(text: string, mode: RedactionMode = 'strict'): string {
  // JWTs first (#492): a prefix pattern masked inside a segment would split the JWT and leave its other segments.
  // A fresh global RegExp per call: a shared one would carry `lastIndex` from one call into the next.
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(new RegExp(pattern[mode], 'g'), `[redacted:${pattern.kind}]`),
    maskJwts(text, mode, '[redacted:jwt]'),
  );
}
