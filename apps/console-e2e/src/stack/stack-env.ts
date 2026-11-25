import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The environment of every process the local stack starts (#982): the Workers on Miniflare (`serve-worker.mts`) and
 * the wrangler CLI that bundles the fakes and migrates the local D1. They get the names below from the parent and
 * the variables the stack sets itself, nothing else — so a token in the developer's shell or the CI job
 * (`CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `CF_ACCESS_CLIENT_SECRET`, `NODE_AUTH_TOKEN`, …) never reaches a test
 * server, its logs or a crash dump. Add a name only when a child cannot run without it, and never one that can hold
 * a credential.
 *
 * - `PATH`: `node_modules/.bin/wrangler` starts through `#!/usr/bin/env node`.
 * - `USER`, `LOGNAME`: `os.userInfo()` fallbacks of the tools.
 * - `TMPDIR`: Miniflare and workerd write their temporary files and sockets there.
 * - `LANG`, `LC_ALL`: the locale of the tools' output.
 * - `CI`: keeps wrangler non-interactive on CI.
 *
 * `HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` are never the host's (#993): wrangler keeps its login there
 * (`<config>/.wrangler/config/default.toml`), and a child that can read the developer's home can read that and
 * every other dotfile. Each child gets the run's own empty home instead (`stackHome`); nothing the stack runs —
 * the bundling, the local D1, Miniflare, workerd — needs anything from the real one.
 *
 * Left out on purpose: `NODE_OPTIONS` (it can preload code or open an inspector), `NODE_EXTRA_CA_CERTS` and the proxy
 * variables (the stack is offline), and every `CLOUDFLARE_*` / `WRANGLER_*` name, which would point wrangler at a
 * real account.
 */
export const STACK_ENV_ALLOWLIST = ['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI'] as const;

/** The home of a run's children: a directory of the run's own, empty until wrangler writes its logs there. */
export interface StackHome {
  readonly HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_CACHE_HOME: string;
}

/**
 * The throwaway home under `stacksDir`, created on first use and readable by the owner only. `global-setup.ts`
 * clears `stacksDir` when a run starts, so nothing a run wrote there reaches the next one.
 *
 * `mkdir` applies its mode only to a directory it creates, so one that is already there — made by hand, or by an
 * older checkout — is tightened as well (#999). A symbolic link in its place is refused, not followed (#1006):
 * `chmod` would change whatever the link names, and the children would write there.
 */
export function stackHome(stacksDir: string): StackHome {
  const home = join(stacksDir, 'home');
  const config = join(home, '.config');
  const cache = join(home, '.cache');
  for (const dir of [home, config, cache]) {
    mkdirSync(dir, { recursive: true, mode: HOME_MODE });
    closeToOthers(dir);
  }
  return { HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache };
}

const HOME_MODE = 0o700;

/**
 * Sets `dir` to the owner only, and throws when it is not a real directory. `lstat` gives the clear error; the mode
 * is then set through a descriptor opened without following links, so a link swapped in after the check is refused
 * by the system as well instead of being followed.
 */
function closeToOthers(dir: string): void {
  const entry = lstatSync(dir);
  if (entry.isSymbolicLink()) {
    throw new Error(`${dir} is a symbolic link: the stack does not use a home it did not make. Remove it.`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${dir} is not a directory: the stack cannot make its home there. Remove it.`);
  }
  const descriptor = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fchmodSync(descriptor, HOME_MODE);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The allowlisted names `parent` has, then `own` — what the stack sets wins over anything inherited — then `home`,
 * which nothing overrides: no caller can hand a child the real home by accident.
 */
export function stackChildEnv(
  parent: NodeJS.ProcessEnv,
  home: StackHome,
  own: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STACK_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...own, ...home };
}
