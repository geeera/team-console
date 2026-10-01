import type { ApiEnv } from './env';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type LocalFakeOrigin =
  /** Not configured, or not a local run: talk to the real service. */
  | { readonly kind: 'off' }
  | { readonly kind: 'fake'; readonly origin: string }
  /** Set on a local run but not a loopback http(s) origin. */
  | { readonly kind: 'invalid' };

/**
 * The `*_FAKE_ORIGIN` vars (`GITHUB_FAKE_ORIGIN`, `ROUTINES_FAKE_ORIGIN`, `PUSH_FAKE_ORIGIN`) point an outbound
 * client at a fake on this machine. They are honoured only with `ENVIRONMENT=local`, and only as a loopback origin,
 * so a deployed Worker can never be steered to another host by one.
 */
export function localFakeOriginOf(env: ApiEnv, value: string | undefined): LocalFakeOrigin {
  const configured = env.ENVIRONMENT === 'local' ? value?.trim() : undefined;
  if (configured === undefined || configured === '') {
    return { kind: 'off' };
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return { kind: 'invalid' };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return { kind: 'invalid' };
  }
  return { kind: 'fake', origin: url.origin };
}
