import { UnsealError, openText, sealText } from '@worker/core';

/**
 * The `state` + PKCE verifier of one connect attempt, sealed into a cookie the callback consumes (ADR 0003
 * decision 3, threat model row 4 on #59). `__Host-` needs `Path=/`, `Secure` and no `Domain` or browsers drop the
 * cookie (#59 threat model A1, amending the decision's `Path=/api/v1/github/callback`); the prefix stays because
 * `workers.dev` is a public suffix and a sibling Worker could otherwise toss a `Domain=` cookie at us.
 */
export const OAUTH_COOKIE = '__Host-tc_oauth';
/** Ten minutes, enforced from the sealed `iat`: `Max-Age` is only a hint to the browser. */
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
// A cookie issued "in the future" beyond ordinary clock skew between isolates was not issued by us.
const CLOCK_SKEW_MS = 60_000;
const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export interface OAuthAttempt {
  readonly state: string;
  readonly verifier: string;
  /** Milliseconds since the epoch. */
  readonly issuedAt: number;
}

function aadOf(environment: string): string {
  return `${environment}:oauth-state`;
}

function isAttempt(value: unknown): value is OAuthAttempt {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['state'] === 'string' &&
    typeof record['verifier'] === 'string' &&
    typeof record['issuedAt'] === 'number' &&
    Number.isSafeInteger(record['issuedAt'])
  );
}

export async function sealAttemptCookie(
  key: CryptoKey,
  environment: string,
  attempt: OAuthAttempt,
): Promise<string> {
  const sealed = await sealText(key, JSON.stringify(attempt), aadOf(environment));
  return `${OAUTH_COOKIE}=${sealed}; Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;
}

/** Same name and attributes, `Max-Age=0`: the browser drops the cookie. Sent on every callback outcome. */
export const CLEAR_ATTEMPT_COOKIE = `${OAUTH_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

export type AttemptCheck =
  | { readonly ok: true; readonly attempt: OAuthAttempt }
  | { readonly ok: false; readonly reason: 'cookie-missing' | 'cookie-unreadable' | 'cookie-expired' };

/** Opens the cookie value and checks its age; tampered, foreign-environment or stale cookies are refused. */
export async function openAttemptCookie(
  key: CryptoKey,
  environment: string,
  value: string | undefined,
  nowMs: number,
): Promise<AttemptCheck> {
  if (value === undefined || value === '') {
    return { ok: false, reason: 'cookie-missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await openText(key, value, aadOf(environment)));
  } catch (error: unknown) {
    if (error instanceof UnsealError || error instanceof SyntaxError) {
      return { ok: false, reason: 'cookie-unreadable' };
    }
    throw error;
  }
  if (!isAttempt(parsed)) {
    return { ok: false, reason: 'cookie-unreadable' };
  }
  const age = nowMs - parsed.issuedAt;
  if (age > OAUTH_COOKIE_MAX_AGE_SECONDS * 1000 || age < -CLOCK_SKEW_MS) {
    return { ok: false, reason: 'cookie-expired' };
  }
  return { ok: true, attempt: parsed };
}
