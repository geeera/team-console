import { ROUTINES_API_ORIGIN, type FetchLike } from '@worker/routines';
import type { ApiEnv } from '../env';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class RoutinesMisconfiguredError extends Error {
  constructor() {
    super('ROUTINES_FAKE_ORIGIN must be a loopback http(s) origin');
    this.name = 'RoutinesMisconfiguredError';
  }
}

/**
 * Local runs only (`ENVIRONMENT=local`, like `GITHUB_FAKE_ORIGIN`): `ROUTINES_FAKE_ORIGIN` sends the fire request to
 * the fake routines API on this machine (`nx run api:fake-routines`). Only a loopback origin is accepted; on any other
 * environment the variable is ignored and the request goes to api.anthropic.com.
 */
export function routinesFetch(env: ApiEnv, base: FetchLike): FetchLike {
  const configured = env.ENVIRONMENT === 'local' ? env.ROUTINES_FAKE_ORIGIN?.trim() : undefined;
  if (configured === undefined || configured === '') {
    return base;
  }
  let fake: URL;
  try {
    fake = new URL(configured);
  } catch {
    throw new RoutinesMisconfiguredError();
  }
  if (!LOOPBACK_HOSTS.has(fake.hostname) || (fake.protocol !== 'http:' && fake.protocol !== 'https:')) {
    throw new RoutinesMisconfiguredError();
  }
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== ROUTINES_API_ORIGIN) {
      throw new TypeError('the fake routines API serves api.anthropic.com only');
    }
    return base(`${fake.origin}${url.pathname}${url.search}`, init);
  };
}
