/** What `local-stack.ts` hands `serve-worker.mts` (#957): one Worker, as `wrangler dev`'s flags named it. */
export interface ServeWorkerOptions {
  /** The Worker's wrangler config, relative to the working directory. */
  readonly config: string;
  /** The config's `env.*` block, if any. */
  readonly env?: string;
  /** The bundled Worker (`wrangler deploy --dry-run --outdir`): Miniflare runs JavaScript only. */
  readonly script: string;
  readonly port: number;
  /** 0: a port the system picks. */
  readonly inspectorPort: number;
  /** The directory `wrangler dev --persist-to` takes, so `wrangler d1 migrations apply --persist-to` fills it. */
  readonly persistTo: string;
  /** `--var NAME:value` of `wrangler dev`: plain-text bindings over the config's `vars`. */
  readonly vars: Readonly<Record<string, string>>;
}

/** The environment variable that carries the options, so the run's throwaway keys never sit in a process list. */
export const SERVE_WORKER_OPTIONS = 'SERVE_WORKER_OPTIONS';

/** The options from their environment variable; throws on anything else, so a wrong start names itself. */
export function parseServeWorkerOptions(raw: string | undefined): ServeWorkerOptions {
  if (raw === undefined || raw === '') {
    throw new Error(`${SERVE_WORKER_OPTIONS} is not set`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isServeWorkerOptions(parsed)) {
    throw new Error(`${SERVE_WORKER_OPTIONS} does not hold a valid set of options`);
  }
  return parsed;
}

function isServeWorkerOptions(value: unknown): value is ServeWorkerOptions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const options = value as Record<string, unknown>;
  const vars = options['vars'];
  return (
    isNonEmptyString(options['config']) &&
    (options['env'] === undefined || isNonEmptyString(options['env'])) &&
    isNonEmptyString(options['script']) &&
    isPort(options['port']) &&
    isPort(options['inspectorPort']) &&
    isNonEmptyString(options['persistTo']) &&
    typeof vars === 'object' &&
    vars !== null &&
    !Array.isArray(vars) &&
    Object.values(vars).every((entry) => typeof entry === 'string')
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535;
}
