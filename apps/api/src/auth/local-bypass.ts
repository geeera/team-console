import type { ApiEnv } from '../env';

/**
 * The local bypass needs both flags (`nx serve api`, the Dockerfile, the specs). `authMiddleware` mints the `local`
 * identity on it, and the owner-only checks accept `local` only while it holds, so a `local` identity that reached
 * a deployed Worker some other way is still refused.
 */
export function isLocalBypass(env: Pick<ApiEnv, 'ENVIRONMENT' | 'AUTH_MODE'>): boolean {
  return env.ENVIRONMENT === 'local' && env.AUTH_MODE === 'local';
}
