import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { startCloseRelay, type CloseRelay } from './close-relay';
import { SERVE_WORKER_OPTIONS, type ServeWorkerOptions } from './serve-worker-options.mts';

export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
/** One directory per Playwright worker: its servers' state and logs (the CI artifact keeps the logs). */
export const STACKS_DIR = join(WORKSPACE_ROOT, 'tmp/console-e2e');

const WRANGLER = join(WORKSPACE_ROOT, 'node_modules/.bin/wrangler');
/** Each server of the stack is a Worker on Miniflare, not a `wrangler dev` (#957, `serve-worker.mts`). */
const SERVE_WORKER = join(__dirname, 'serve-worker.mts');
const API_CONFIG = 'apps/api/wrangler.jsonc';
const FAKE_CONFIG = 'apps/api/fake-github/wrangler.jsonc';
const FAKE_PUSH_CONFIG = 'apps/api/fake-push/wrangler.jsonc';
/** The bundle `nx build api` writes and the Docker image runs, so the suite tests what ships. */
const API_BUNDLE = 'dist/apps/api/main.js';
const CONSOLE_INDEX = 'dist/apps/console/browser/index.html';
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;

// Fake OAuth app values the fake GitHub and the api agree on; nothing here is a credential.
const FAKE_CLIENT_ID = 'Iv23liLOCALFAKE';
const FAKE_CLIENT_SECRET = 'local-fake-secret';
const MOCK_OWNER = { login: 'geeera', id: 100_001 } as const;
/** The runner image digest the local stack names (#634 PR 7); the specs only read it back from the API's command. */
export const E2E_RUNNER_IMAGE_DIGEST = `sha256:${'e2e0'.repeat(16)}`;

export interface StackPorts {
  readonly api: number;
  readonly fake: number;
  readonly apiInspector: number;
  readonly fakeInspector: number;
  readonly fakePush: number;
  readonly fakePushInspector: number;
}

/**
 * Ten ports per Playwright worker, so parallel workers never share a server or a database. `E2E_PORT_BASE` (local
 * runs beside other stacks on one machine) packs a worker into three ports from that base — api, fake GitHub, fake
 * push — with the devtools inspectors on ports the system picks (inspector port 0).
 */
export function portsFor(parallelIndex: number): StackPorts {
  const packed = Number(process.env['E2E_PORT_BASE'] ?? '');
  if (Number.isInteger(packed) && packed > 1024) {
    const first = packed + parallelIndex * 3;
    return {
      api: first,
      fake: first + 1,
      apiInspector: 0,
      fakeInspector: 0,
      fakePush: first + 2,
      fakePushInspector: 0,
    };
  }
  const base = 18_700 + parallelIndex * 10;
  return {
    api: base,
    fake: base + 1,
    apiInspector: base + 2,
    fakeInspector: base + 3,
    fakePush: base + 4,
    fakePushInspector: base + 5,
  };
}

/** Log lines of a server that stopped serving on its own: workerd died and Miniflare restarted it in place (#230). */
const INCIDENT_MARKERS = ['The Workers runtime crashed unexpectedly'] as const;

/**
 * One `serve-worker.mts` and the workerd its Miniflare forks. Every lifetime appends to the log between two marker
 * lines, so a worker's logs keep every api restart of the run (a truncating `reset()` used to drop the evidence of a
 * crash).
 */
class StackProcess {
  private spawnError: Error | null = null;
  /** Byte offset in the log where the harness began stopping this process; `null` while it runs. */
  private stopStart: number | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
    private readonly logPath: string,
    /** Byte offset in the log where this lifetime's output starts. */
    private readonly logStart: number,
  ) {
    child.on('error', (error) => {
      this.spawnError = error;
    });
    child.on('exit', (code, exitSignal) => {
      const how = this.stopStart === null ? 'EXITED UNEXPECTEDLY' : 'stopped by the harness';
      appendLog(
        logPath,
        `=== ${new Date().toISOString()} ${label} ${how} (code ${code}, signal ${exitSignal}) ===`,
      );
    });
  }

  static spawn(label: string, options: ServeWorkerOptions, logPath: string): StackProcess {
    appendLog(
      logPath,
      `=== ${new Date().toISOString()} ${label} start: serve-worker ${describeOptions(options)} ===`,
    );
    const logStart = statSync(logPath).size;
    const log = openSync(logPath, 'a');
    try {
      // Own process group: Miniflare forks workerd, and stopping the group takes both down.
      const child = spawn(process.execPath, ['--experimental-strip-types', SERVE_WORKER], {
        cwd: WORKSPACE_ROOT,
        detached: true,
        stdio: ['ignore', log, log],
        env: {
          ...process.env,
          [SERVE_WORKER_OPTIONS]: JSON.stringify(options),
          WRANGLER_SEND_METRICS: 'false',
          // Plain logs: Playwright sets FORCE_COLOR for its workers, and it would override NO_COLOR.
          FORCE_COLOR: '0',
        },
      });
      return new StackProcess(child, label, logPath, logStart);
    } finally {
      closeSync(log);
    }
  }

  get hasExited(): boolean {
    return this.spawnError !== null || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** This lifetime's output, up to where the harness began stopping it. */
  output(): string {
    if (!existsSync(this.logPath)) {
      return '';
    }
    const log = readFileSync(this.logPath);
    return log.subarray(this.logStart, this.stopStart ?? log.length).toString('utf8');
  }

  logTail(): string {
    const log = this.output().split('\n').slice(-40).join('\n');
    return this.spawnError === null ? log : `${this.spawnError.message}\n${log}`;
  }

  /**
   * Every time this process stopped serving on its own: a workerd crash Miniflare restarted in place (the in-flight
   * request answers 500 and the port refuses connections until workerd is back), or the serve-worker process exiting.
   */
  incidents(): string[] {
    const found = this.output()
      .split('\n')
      .filter((line) => INCIDENT_MARKERS.some((marker) => line.includes(marker)))
      .map((line) => `${this.label}: ${line.trim()}`);
    if (this.hasExited && this.stopStart === null) {
      found.push(`${this.label}: the server exited on its own`);
    }
    return found;
  }

  /**
   * SIGTERM to the serve-worker process alone, so Miniflare disposes its workerd itself. Signalling the whole group
   * raced the two: workerd died first, Miniflare took that for a crash and began starting a new workerd while its
   * process was exiting. Whatever is left in the group afterwards is killed.
   */
  async stop(): Promise<void> {
    if (this.stopStart === null) {
      this.stopStart = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    }
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }
    if (!this.hasExited) {
      const exited = new Promise<void>((done) => this.child.once('exit', () => done()));
      signal(pid, 'SIGTERM', pid);
      const timer = setTimeout(() => signal(-pid, 'SIGKILL', pid), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    signal(-pid, 'SIGKILL', pid);
  }
}

/**
 * `target` is a pid, or a process group as `-pgid`; `pid` (always positive) is the child whose liveness decides a
 * `EPERM`. ESRCH (already gone) is what stopping wants. macOS can answer EPERM instead of ESRCH for a process group
 * whose leader already exited (#846): the race between `stop()`'s own exit check and the signal landing. `pid` is
 * re-probed with signal 0 at the moment of the error, so only an EPERM for a process still alive is surfaced —
 * never swallowed silently.
 */
export function signal(target: number, name: NodeJS.Signals, pid: number): void {
  try {
    process.kill(target, name);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error)) {
      throw error;
    }
    if (error.code === 'ESRCH') {
      return;
    }
    if (error.code === 'EPERM' && !isAlive(pid)) {
      return;
    }
    throw error;
  }
}

/** Whether `pid` still exists, probed with signal 0 (sends nothing). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function appendLog(logPath: string, line: string): void {
  appendFileSync(logPath, `${line}\n`);
}

/** The options for the log, vars by name only, so the run's throwaway keys stay out of the artifact. */
export function describeOptions(options: ServeWorkerOptions): string {
  const env = options.env === undefined ? '' : ` --env ${options.env}`;
  const vars = Object.keys(options.vars).map((name) => ` --var ${name}:…`);
  return `${options.script} --config ${options.config}${env} --port ${options.port} --persist-to ${options.persistTo}${vars.join('')}`;
}

/**
 * A VAPID pair for this run only (#36): web push runs end to end against the fake push service, never a real one.
 * JWK export keeps the scalar and coordinates at 32 bytes each (tools/owner-setup/vapid-keygen.js).
 */
function throwawayVapidPair(): { publicKey: string; privateKey: string } {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x ?? '', 'base64url'),
    Buffer.from(jwk.y ?? '', 'base64url'),
  ]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d ?? '' };
}

async function waitForOk(url: string, process: StackProcess, name: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'no answer yet';
  while (Date.now() < deadline) {
    if (process.hasExited) {
      throw new Error(`${name} exited during start:\n${process.logTail()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((done) => setTimeout(done, 250));
  }
  throw new Error(
    `${name} not ready at ${url} after ${START_TIMEOUT_MS} ms (${lastError}):\n${process.logTail()}`,
  );
}

function run(args: readonly string[], logPath: string): Promise<void> {
  const log = openSync(logPath, 'a');
  return new Promise<void>((done, fail) => {
    const child = spawn(WRANGLER, args, {
      cwd: WORKSPACE_ROOT,
      stdio: ['ignore', log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
    });
    child.on('error', (error) => fail(error));
    child.on('exit', (code) => {
      closeSync(log);
      if (code === 0) {
        done();
      } else {
        fail(new Error(`wrangler ${args.slice(0, 3).join(' ')} exited with ${code}; see ${logPath}`));
      }
    });
  });
}

/**
 * A fake's TypeScript Worker bundled the way `wrangler dev` bundled it (`wrangler deploy --dry-run`, as `nx build api`
 * does for the api), since Miniflare runs JavaScript only. `--outdir` resolves against the config's directory, so it
 * is absolute here.
 */
async function bundleWorker(config: string, outdir: string, logPath: string): Promise<string> {
  await run(['deploy', '--dry-run', '--config', config, '--outdir', outdir], logPath);
  const scripts = readdirSync(outdir).filter((file) => file.endsWith('.js'));
  const [script] = scripts;
  if (script === undefined || scripts.length > 1) {
    throw new Error(
      `${config}: expected one bundled script in ${outdir}, found ${scripts.join(', ') || 'none'}`,
    );
  }
  return join(outdir, script);
}

/**
 * One isolated backend for one Playwright worker: the fake GitHub (`apps/api/fake-github`) and the api Worker with
 * what the Docker image runs — the built bundle, its wrangler config, a fresh local D1, `ENVIRONMENT=local` +
 * `AUTH_MODE=local` + `GITHUB_MOCK=true` — with `GITHUB_FAKE_ORIGIN` pointing at the fake, so the owner's OAuth round
 * trip and answer comments never leave the machine. Unlike the image, every server runs on Miniflare directly, not
 * through `wrangler dev` (#957, `serve-worker.mts`): its ProxyWorker drops a non-GET request on a keep-alive race.
 */
export class LocalStack {
  readonly baseURL: string;
  readonly fakeURL: string;
  readonly fakePushURL: string;
  private api: StackProcess | null = null;
  private fakePush: StackProcess | null = null;
  /** The api's way to the fakes (#400, `close-relay.ts`); the browser and the specs still reach them direct. */
  private readonly relays: { github: CloseRelay | null; push: CloseRelay | null } = {
    github: null,
    push: null,
  };
  private readonly pastIncidents: string[] = [];
  private readonly vapid = throwawayVapidPair();
  /** Settles once per stack; a failed migration stays failed, so every reset reports it instead of retrying. */
  private template: Promise<string> | null = null;

  private constructor(
    private readonly name: string,
    private readonly ports: StackPorts,
    private readonly dir: string,
    private readonly fake: StackProcess,
    private readonly fakePushScript: string,
  ) {
    this.baseURL = `http://127.0.0.1:${ports.api}`;
    this.fakeURL = `http://127.0.0.1:${ports.fake}`;
    this.fakePushURL = `http://127.0.0.1:${ports.fakePush}`;
  }

  static async start(name: string, ports: StackPorts): Promise<LocalStack> {
    for (const built of [API_BUNDLE, CONSOLE_INDEX]) {
      if (!existsSync(join(WORKSPACE_ROOT, built))) {
        throw new Error(
          `${built} is missing: build first (npx nx build api), or run through npx nx e2e console-e2e`,
        );
      }
    }
    const dir = join(STACKS_DIR, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [fakeScript, fakePushScript] = await Promise.all([
      bundleWorker(FAKE_CONFIG, join(dir, 'fake-github-bundle'), join(dir, 'fake-github-bundle.log')),
      bundleWorker(FAKE_PUSH_CONFIG, join(dir, 'fake-push-bundle'), join(dir, 'fake-push-bundle.log')),
    ]);
    const fake = StackProcess.spawn(
      `${name} fake GitHub`,
      {
        config: FAKE_CONFIG,
        script: fakeScript,
        port: ports.fake,
        inspectorPort: ports.fakeInspector,
        persistTo: join(dir, 'fake-state'),
        vars: { FAKE_GITHUB_CLIENT_ID: FAKE_CLIENT_ID, FAKE_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET },
      },
      join(dir, 'fake-github.log'),
    );
    const stack = new LocalStack(name, ports, dir, fake, fakePushScript);
    try {
      await waitForOk(`${stack.fakeURL}/_fake/state`, fake, `${name} fake GitHub`);
      await stack.startFakePush();
      await stack.startRelays();
      await stack.signInAsMockOwner();
      await stack.startApi();
    } catch (error: unknown) {
      try {
        await stack.stop();
      } catch (stopError: unknown) {
        // stop() itself can throw an AggregateError (several parts failed to shut down); that must never
        // replace the start failure the caller actually needs to see.
        const why = stopError instanceof Error ? stopError.message : String(stopError);
        process.stderr.write(`${name}: cleanup after a failed start also failed: ${why}\n`);
      }
      throw error;
    }
    return stack;
  }

  /** A fresh database and a fresh api isolate (no cached connection or reads); the fake GitHub keeps running. */
  async reset(): Promise<void> {
    await this.retireApi();
    await this.startApi();
  }

  /**
   * Every time one of this stack's servers stopped serving on its own, oldest first. A spec checks that the count did
   * not grow while it ran, so a crash fails the test that saw it with the reason, not as an empty screen.
   */
  incidents(): string[] {
    return [
      ...this.pastIncidents,
      ...[this.fake, this.fakePush, this.api].flatMap((process) => process?.incidents() ?? []),
    ];
  }

  private async retireApi(): Promise<void> {
    if (this.api === null) {
      return;
    }
    await this.api.stop();
    this.pastIncidents.push(...this.api.incidents());
    this.api = null;
  }

  /** Api first, then what it talks to; every step runs even when an earlier one fails, so nothing is leaked. */
  async stop(): Promise<void> {
    const { github, push } = this.relays;
    this.relays.github = null;
    this.relays.push = null;
    const fakePush = this.fakePush;
    this.fakePush = null;
    const failures: unknown[] = [];
    for (const step of [
      () => this.retireApi(),
      async () => {
        const closed = await Promise.allSettled([github?.close(), push?.close()]);
        failures.push(...closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])));
      },
      async () => fakePush?.stop(),
      () => this.fake.stop(),
    ]) {
      try {
        await step();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${this.name}: ${failures.length} part(s) of the stack did not stop`,
      );
    }
  }

  /** Upstream failures land in `relay.log` beside the servers' logs, so the CI artifact keeps them. */
  private async startRelays(): Promise<void> {
    const log = join(this.dir, 'relay.log');
    const onError = (to: string) => (error: Error) => {
      const line = `${new Date().toISOString()} ${this.name} relay to ${to}: ${error.message}`;
      // Called from a socket event: a throw here would take the whole Playwright worker down.
      try {
        appendLog(log, line);
      } catch (logError: unknown) {
        const why = logError instanceof Error ? logError.message : String(logError);
        process.stderr.write(`${line}\n(relay.log not writable: ${why})\n`);
      }
    };
    this.relays.github = await startCloseRelay(this.fakeURL, onError('fake GitHub'));
    this.relays.push = await startCloseRelay(this.fakePushURL, onError('fake push'));
  }

  private relayOrigin(relay: CloseRelay | null): string {
    if (relay === null) {
      throw new Error(`${this.name}: the relays start before the api`);
    }
    return relay.origin;
  }

  /** The fake push service (Apple, FCM, Mozilla stand-in) of `nx run api:fake-push`, on this worker's own port. */
  private async startFakePush(): Promise<void> {
    this.fakePush = StackProcess.spawn(
      `${this.name} fake push`,
      {
        config: FAKE_PUSH_CONFIG,
        script: this.fakePushScript,
        port: this.ports.fakePush,
        inspectorPort: this.ports.fakePushInspector,
        persistTo: join(this.dir, 'fake-push-state'),
        vars: {},
      },
      join(this.dir, 'fake-push.log'),
    );
    await waitForOk(`${this.fakePushURL}/_fake/state`, this.fakePush, `${this.name} fake push`);
  }

  /**
   * The fake's OAuth user becomes the owner of the mock repositories (libs/worker/github/fixtures/mock-github.json,
   * `geeera`, id 100001); the answer route checks the repository owner by login and id, as it does on GitHub.
   */
  private async signInAsMockOwner(): Promise<void> {
    const response = await fetch(`${this.fakeURL}/_fake/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: MOCK_OWNER.login, id: MOCK_OWNER.id }),
    });
    if (!response.ok) {
      throw new Error(`fake GitHub refused the owner user: ${response.status} ${await response.text()}`);
    }
  }

  /** A local D1 with every migration applied and nothing else; wrangler has exited, so its files are at rest. */
  private migratedTemplate(): Promise<string> {
    this.template ??= (async () => {
      const template = join(this.dir, 'api-state-template');
      rmSync(template, { recursive: true, force: true });
      await run(
        [
          'd1',
          'migrations',
          'apply',
          'team-console-dev',
          '--local',
          '--config',
          API_CONFIG,
          '--env',
          'dev',
          '--persist-to',
          template,
        ],
        join(this.dir, 'migrate.log'),
      );
      return template;
    })();
    return this.template;
  }

  /**
   * Every reset starts from a copy of this worker's migrated template instead of re-running all migrations: the
   * `wrangler d1 migrations apply` subprocess took ~15 s per test on CI and pushed long specs past the 30 s timeout
   * (#864). The template is migrated once per stack, so a run still tests the migrations it was started with.
   */
  private async startApi(): Promise<void> {
    const persist = join(this.dir, 'api-state');
    rmSync(persist, { recursive: true, force: true });
    cpSync(await this.migratedTemplate(), persist, { recursive: true });
    this.api = StackProcess.spawn(
      `${this.name} api`,
      {
        config: API_CONFIG,
        env: 'dev',
        script: API_BUNDLE,
        port: this.ports.api,
        inspectorPort: this.ports.apiInspector,
        persistTo: persist,
        vars: {
          // The Dockerfile's local switches, plus the fake GitHub for the owner connection and owner writes.
          ENVIRONMENT: 'local',
          AUTH_MODE: 'local',
          GITHUB_MOCK: 'true',
          OWNER_GITHUB_LOGIN: 'geeera',
          GITHUB_FAKE_ORIGIN: this.relayOrigin(this.relays.github),
          GITHUB_APP_CLIENT_ID: FAKE_CLIENT_ID,
          GITHUB_APP_CLIENT_SECRET: FAKE_CLIENT_SECRET,
          // A throwaway key per run: it seals the fake owner token in this run's own database only.
          TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          ROUTINE_TOKEN_TEAM_CONSOLE: 'local-fake-routine',
          // Web push (#36) against the fake push service only, with this run's throwaway VAPID pair.
          PUSH_FAKE_ORIGIN: this.relayOrigin(this.relays.push),
          VAPID_PUBLIC_KEY: this.vapid.publicKey,
          VAPID_PRIVATE_KEY: this.vapid.privateKey,
          // Settings › Runners flags a runner below the minimum (#464); runners.e2e.ts enrols one at 0.1.0.
          RUNNER_RELEASE_VERSION: '0.3.0',
          // #634 PR 7: a digest for that release's image, so the wizard's Linux choice gets the API's command.
          RUNNER_RELEASE_IMAGE_DIGEST: E2E_RUNNER_IMAGE_DIGEST,
          RUNNER_MINIMUM_VERSION: '0.2.0',
        },
      },
      join(this.dir, 'api.log'),
    );
    await waitForOk(`${this.baseURL}/api/v1/healthz`, this.api, `${this.name} api`);
  }
}
