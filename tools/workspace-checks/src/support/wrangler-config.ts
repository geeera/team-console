import { workspaceRoot } from '@nx/devkit';
import { join } from 'node:path';
import * as wrangler from 'wrangler';

/**
 * The one place the workspace checks read `apps/<worker>/wrangler.jsonc`.
 *
 * Wrangler's own reader resolves the `env.*` blocks and validates the file, so the checks see what a deploy sees. It
 * is exported only as `unstable_readConfig`, which any wrangler release may rename or reshape (the package is pinned
 * exactly in package.json, so that happens on a deliberate upgrade). The export is looked up at run time and its
 * result narrowed here: after such an upgrade every check fails with one message that names this file, instead of
 * reading `undefined` or a changed shape and passing or failing for the wrong reason.
 */

export const WORKER_APPS = ['api', 'hooks'] as const;
export type WorkerApp = (typeof WORKER_APPS)[number];

export const DEPLOY_ENVIRONMENTS = ['dev', 'stage', 'production'] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

export interface D1DatabaseConfig {
  readonly binding: string;
  readonly database_name: string;
  readonly database_id: string;
  readonly migrations_dir?: string;
}

/** The part of wrangler's resolved config the checks read; wrangler returns more. */
export interface WranglerEnvConfig {
  readonly name: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly d1_databases: readonly D1DatabaseConfig[];
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly assets?: {
    readonly binding?: string;
    readonly not_found_handling?: string;
    readonly run_worker_first?: readonly string[] | boolean;
  };
}

export type ReadWranglerConfig = (
  args: { readonly config: string; readonly env: string },
  options: { readonly hideWarnings: boolean },
) => unknown;

const READER_EXPORT = 'unstable_readConfig';
const THIS_FILE = 'tools/workspace-checks/src/support/wrangler-config.ts';

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isD1DatabaseConfig(value: unknown): value is D1DatabaseConfig {
  if (!isRecord(value)) {
    return false;
  }
  const migrations = field(value, 'migrations_dir');
  return (
    typeof field(value, 'binding') === 'string' &&
    typeof field(value, 'database_name') === 'string' &&
    typeof field(value, 'database_id') === 'string' &&
    (migrations === undefined || typeof migrations === 'string')
  );
}

export function isWranglerEnvConfig(value: unknown): value is WranglerEnvConfig {
  if (!isRecord(value)) {
    return false;
  }
  const databases = field(value, 'd1_databases');
  return (
    typeof field(value, 'name') === 'string' &&
    typeof field(value, 'main') === 'string' &&
    typeof field(value, 'compatibility_date') === 'string' &&
    isRecord(field(value, 'vars')) &&
    Array.isArray(databases) &&
    databases.every(isD1DatabaseConfig)
  );
}

/** Wrangler's config reader out of `module` (the installed `wrangler` by default); throws when it is not there. */
export function wranglerConfigReader(module: object = wrangler): ReadWranglerConfig {
  const reader: unknown = field(module, READER_EXPORT);
  if (typeof reader !== 'function') {
    throw new Error(
      `wrangler no longer exports ${READER_EXPORT}; point ${THIS_FILE} at its config reader before upgrading`,
    );
  }
  return (args, options) => {
    const config: unknown = Reflect.apply(reader, module, [args, options]);
    return config;
  };
}

/** `apps/<app>/wrangler.jsonc` resolved for `env`, as wrangler reads it for a deploy. */
export function readWorkerConfig(
  app: WorkerApp,
  env: DeployEnvironment,
  read: ReadWranglerConfig = wranglerConfigReader(),
): WranglerEnvConfig {
  const config = read(
    { config: join(workspaceRoot, 'apps', app, 'wrangler.jsonc'), env },
    { hideWarnings: true },
  );
  if (!isWranglerEnvConfig(config)) {
    throw new Error(
      `wrangler returned an unexpected config shape for apps/${app} env ${env}; check ${THIS_FILE} against it`,
    );
  }
  return config;
}
