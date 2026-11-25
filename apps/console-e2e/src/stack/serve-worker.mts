/**
 * One Worker of the local e2e stack on Miniflare, without `wrangler dev` (#957). `wrangler dev` answers on its port
 * through a ProxyWorker that forwards to the Worker over a pool of keep-alive connections, and answers a non-GET
 * request that picks a connection the other end closed at 5 s idle with a 500 «Error: Network connection lost.»
 * the Worker never saw (#947). Here the client talks to workerd directly, as it talks to Cloudflare in production.
 *
 * The bindings, D1 databases, assets and compatibility settings come from the Worker's own wrangler config, read by
 * wrangler itself (`unstable_getMiniflareWorkerOptions`); Miniflare is the copy wrangler ships, so workerd is the one
 * `wrangler dev` would run. Started by `local-stack.ts` as `node serve-worker.mts` (type stripping) in its own process
 * group, with its options in `SERVE_WORKER_OPTIONS`; on SIGTERM Miniflare's own exit hook stops workerd and exits.
 * It also stops by itself once the process that started it is gone (#982, `orphan-watch.mts`), within a deadline
 * (#993); the one extra argument it is started with only marks the process for `stale-servers.ts`.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from 'wrangler';
// Types only, from the hoisted copy; the value below is the Miniflare wrangler itself depends on.
import type * as MiniflareModule from 'miniflare';
import { describeError, onOrphaned, parentPidFrom, STACK_PARENT_PID, stopOrphaned } from './orphan-watch.mts';
import {
  parseServeWorkerOptions,
  SERVE_WORKER_OPTIONS,
  type ServeWorkerOptions,
} from './serve-worker-options.mts';

const requireFromWrangler = createRequire(import.meta.resolve('wrangler'));
const { convertV4MiniflareOptions, Log, LogLevel, Miniflare } = requireFromWrangler(
  'miniflare',
) as typeof MiniflareModule;

async function serve(options: ServeWorkerOptions): Promise<void> {
  const config = unstable_readConfig({ config: options.config, env: options.env });
  // wrangler's own typing of these options is loose; they are Miniflare's v4 worker options.
  const fromConfig = {
    ...(unstable_getMiniflareWorkerOptions(config, options.env)
      .workerOptions as MiniflareModule.V4WorkerOptions),
  };
  // The script is one self-contained bundle; Miniflare 5's v4 converter refuses a worker that names module rules.
  delete fromConfig.modulesRules;
  const worker: MiniflareModule.V4WorkerOptions = {
    ...fromConfig,
    name: config.name,
    modules: true,
    // Miniflare resolves a relative path against the config's directory, not the working directory, and names the
    // module by its path from `modulesRoot`: one outside it (`../…`) fails the Worker's start.
    scriptPath: resolve(options.script),
    modulesRoot: dirname(resolve(options.script)),
    bindings: { ...fromConfig.bindings, ...options.vars },
  };
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      workers: [worker],
      host: '127.0.0.1',
      port: options.port,
      inspectorPort: options.inspectorPort,
      // wrangler's own layout under --persist-to (`<dir>/v3/d1/…`), so the migrated template copies in as it is.
      resourcePersistencePath: join(resolve(options.persistTo), 'v3'),
      // Miniflare's fallback `request.cf` rather than one fetched from workers.cloudflare.com: the stack stays offline.
      cf: false,
      log: new Log(LogLevel.INFO),
      // wrangler dev printed one line per request; the logs keep them as evidence.
      logRequests: true,
    }),
  );
  onOrphaned(() => void stopOrphaned(() => miniflare.dispose()), {
    parentPid: parentPidFrom(process.env[STACK_PARENT_PID]),
  });
  const url = await miniflare.ready;
  process.stdout.write(`serve-worker: ${options.config} ready on ${url.href}\n`);
}

async function main(): Promise<void> {
  await serve(parseServeWorkerOptions(process.env[SERVE_WORKER_OPTIONS]));
}

main().catch((error: unknown) => {
  process.stderr.write(`serve-worker: ${describeError(error)}\n`);
  process.exit(1);
});
