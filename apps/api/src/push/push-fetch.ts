import { isAllowedPushEndpoint, type FetchLike } from '@worker/push';
import type { ApiEnv } from '../env';
import { localFakeOriginOf } from '../local-fake-origin';

export class PushMisconfiguredError extends Error {
  constructor() {
    super('PUSH_FAKE_ORIGIN must be a loopback http(s) origin');
    this.name = 'PushMisconfiguredError';
  }
}

/**
 * Local runs only (`ENVIRONMENT=local`): `PUSH_FAKE_ORIGIN` sends each push to the fake push service on this machine
 * as `<fake>/<host><path>`, so the whole flow runs without Apple, FCM or Mozilla. Anywhere else it is ignored.
 */
export function pushFetch(env: ApiEnv, base: FetchLike): FetchLike {
  const fake = localFakeOriginOf(env, env.PUSH_FAKE_ORIGIN);
  if (fake.kind === 'off') {
    return base;
  }
  if (fake.kind === 'invalid') {
    throw new PushMisconfiguredError();
  }
  return async (input, init) => {
    if (!isAllowedPushEndpoint(input)) {
      throw new TypeError('the fake push service serves push-service endpoints only');
    }
    const url = new URL(input);
    return base(`${fake.origin}/${url.host}${url.pathname}${url.search}`, init);
  };
}
