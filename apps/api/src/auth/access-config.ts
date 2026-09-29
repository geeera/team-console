import { isEnvironment, type Environment } from '@shared/contracts';
import type { ApiEnv } from '../env';

/** Access team domains only: anything else could point the JWKS fetch at a host we do not trust (threat model #8, row 8). */
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

/** Validated Access settings for one request; built from bindings, never from request data. */
export interface AccessConfig {
  readonly teamDomain: string;
  readonly issuer: string;
  readonly jwksUrl: URL;
  readonly audience: string;
  /** Lower-cased for the case-insensitive comparison with the token's `email`. */
  readonly ownerEmail: string;
  /** The one service token `common_name` accepted, or null when service tokens are off for this environment. */
  readonly serviceTokenId: string | null;
}

export type AccessConfigResult =
  | { readonly ok: true; readonly config: AccessConfig }
  | { readonly ok: false; readonly invalid: readonly string[] };

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Service tokens need all three: the flag, a pinned client id and a non-production environment. The environment
 * check is an allow-list, so a mis-set flag in production or an unknown environment name still rejects.
 */
function serviceTokenIdOf(env: ApiEnv, environment: Environment): string | null {
  const allowed = env.ALLOW_SERVICE_TOKEN === 'true' && (environment === 'dev' || environment === 'stage');
  return allowed ? nonEmpty(env.ACCESS_SERVICE_TOKEN_ID) : null;
}

/** Reads and validates the Access bindings. Any missing or malformed value makes every request fail closed. */
export function readAccessConfig(env: ApiEnv): AccessConfigResult {
  const invalid: string[] = [];
  const environment: string = env.ENVIRONMENT;
  const teamDomain = nonEmpty(env.ACCESS_TEAM_DOMAIN);
  const audience = nonEmpty(env.ACCESS_AUD);
  const ownerEmail = nonEmpty(env.OWNER_EMAIL);

  if (!isEnvironment(environment)) {
    invalid.push('ENVIRONMENT');
  }
  if (teamDomain === null || !TEAM_DOMAIN.test(teamDomain)) {
    invalid.push('ACCESS_TEAM_DOMAIN');
  }
  if (audience === null) {
    invalid.push('ACCESS_AUD');
  }
  if (ownerEmail === null) {
    invalid.push('OWNER_EMAIL');
  }
  // The null checks repeat `invalid` only so TypeScript narrows the values below.
  if (
    invalid.length > 0 ||
    !isEnvironment(environment) ||
    teamDomain === null ||
    audience === null ||
    ownerEmail === null
  ) {
    return { ok: false, invalid };
  }

  const issuer = `https://${teamDomain}`;
  return {
    ok: true,
    config: {
      teamDomain,
      issuer,
      jwksUrl: new URL(`${issuer}/cdn-cgi/access/certs`),
      audience,
      ownerEmail: ownerEmail.toLowerCase(),
      serviceTokenId: serviceTokenIdOf(env, environment),
    },
  };
}
