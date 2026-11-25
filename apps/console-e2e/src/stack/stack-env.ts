/**
 * The environment of every process the local stack starts (#982): the Workers on Miniflare (`serve-worker.mts`) and
 * the wrangler CLI that bundles the fakes and migrates the local D1. They get the names below from the parent and
 * the variables the stack sets itself, nothing else — so a token in the developer's shell or the CI job
 * (`CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `CF_ACCESS_CLIENT_SECRET`, `NODE_AUTH_TOKEN`, …) never reaches a test
 * server, its logs or a crash dump. Add a name only when a child cannot run without it, and never one that can hold
 * a credential.
 *
 * - `PATH`: `node_modules/.bin/wrangler` starts through `#!/usr/bin/env node`.
 * - `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`: where wrangler keeps its own config, logs and caches.
 * - `USER`, `LOGNAME`: `os.userInfo()` fallbacks of the tools.
 * - `TMPDIR`: Miniflare and workerd write their temporary files and sockets there.
 * - `LANG`, `LC_ALL`: the locale of the tools' output.
 * - `CI`: keeps wrangler non-interactive on CI.
 *
 * Left out on purpose: `NODE_OPTIONS` (it can preload code or open an inspector), `NODE_EXTRA_CA_CERTS` and the proxy
 * variables (the stack is offline), and every `CLOUDFLARE_*` / `WRANGLER_*` name, which would point wrangler at a
 * real account.
 */
export const STACK_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CI',
] as const;

/** The allowlisted names `parent` has, then `own`: what the stack sets wins over anything inherited. */
export function stackChildEnv(
  parent: NodeJS.ProcessEnv,
  own: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STACK_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...own };
}
