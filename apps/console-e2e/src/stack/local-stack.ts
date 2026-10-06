import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const WRANGLER = join(WORKSPACE_ROOT, 'node_modules/.bin/wrangler');
const API_CONFIG = 'apps/api/wrangler.jsonc';
const FAKE_CONFIG = 'apps/api/fake-github/wrangler.jsonc';
const FAKE_PUSH_CONFIG = 'apps/api/fake-push/wrangler.jsonc';
/**
 * The bundle `nx build api` writes and the Docker image runs, so the suite tests what ships. Not `--no-bundle`: with
 * it wrangler 4.124's esbuild service stops after start and the next log it formats crashes the runtime (#58).
 */
const API_BUNDLE = 'dist/apps/api/main.js';
const CONSOLE_INDEX = 'dist/apps/console/browser/index.html';
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;

// Fake OAuth app values the fake GitHub and the api agree on; nothing here is a credential.
const FAKE_CLIENT_ID = 'Iv23liLOCALFAKE';
const FAKE_CLIENT_SECRET = 'local-fake-secret';
const MOCK_OWNER = { login: 'geeera', id: 100_001 } as const;

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
 * push — with the devtools inspectors on ports the system picks (`--inspector-port 0`).
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

class StackProcess {
  private spawnError: Error | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly logPath: string,
  ) {
    child.on('error', (error) => {
      this.spawnError = error;
    });
  }

  static spawn(args: readonly string[], logPath: string): StackProcess {
    const log = openSync(logPath, 'w');
    try {
      // Own process group: wrangler forks workerd, and stopping the group takes both down.
      const child = spawn(WRANGLER, args, {
        cwd: WORKSPACE_ROOT,
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      });
      return new StackProcess(child, logPath);
    } finally {
      closeSync(log);
    }
  }

  get hasExited(): boolean {
    return this.spawnError !== null || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  logTail(): string {
    const log = existsSync(this.logPath)
      ? readFileSync(this.logPath, 'utf8').split('\n').slice(-40).join('\n')
      : '';
    return this.spawnError === null ? log : `${this.spawnError.message}\n${log}`;
  }

  async stop(): Promise<void> {
    if (this.child.pid === undefined) {
      return;
    }
    if (this.hasExited) {
      // wrangler itself is gone; make sure no workerd it forked outlives it.
      this.signalGroup('SIGKILL');
      return;
    }
    const exited = new Promise<void>((done) => this.child.once('exit', () => done()));
    this.signalGroup('SIGTERM');
    const timer = setTimeout(() => this.signalGroup('SIGKILL'), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error: unknown) {
      // ESRCH: the group is already gone, which is what stopping wants.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
  }
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
 * One isolated backend for one Playwright worker: the fake GitHub (`apps/api/fake-github`) and the api Worker as
 * the Docker image runs it — the built bundle, a fresh local D1, `ENVIRONMENT=local` + `AUTH_MODE=local` +
 * `GITHUB_MOCK=true` — with `GITHUB_FAKE_ORIGIN` pointing at the fake, so the owner's OAuth round trip and answer
 * comments never leave the machine.
 */
export class LocalStack {
  readonly baseURL: string;
  readonly fakeURL: string;
  readonly fakePushURL: string;
  private api: StackProcess | null = null;
  private fakePush: StackProcess | null = null;
  private readonly vapid = throwawayVapidPair();

  private constructor(
    private readonly name: string,
    private readonly ports: StackPorts,
    private readonly dir: string,
    private readonly fake: StackProcess,
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
    const dir = join(WORKSPACE_ROOT, 'tmp/console-e2e', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const fake = StackProcess.spawn(
      [
        'dev',
        '--config',
        FAKE_CONFIG,
        '--ip',
        '127.0.0.1',
        '--port',
        String(ports.fake),
        '--inspector-port',
        String(ports.fakeInspector),
        '--persist-to',
        join(dir, 'fake-state'),
        '--show-interactive-dev-session=false',
        '--var',
        `FAKE_GITHUB_CLIENT_ID:${FAKE_CLIENT_ID}`,
        '--var',
        `FAKE_GITHUB_CLIENT_SECRET:${FAKE_CLIENT_SECRET}`,
      ],
      join(dir, 'fake-github.log'),
    );
    const stack = new LocalStack(name, ports, dir, fake);
    try {
      await waitForOk(`${stack.fakeURL}/_fake/state`, fake, `${name} fake GitHub`);
      await stack.startFakePush();
      await stack.signInAsMockOwner();
      await stack.startApi();
    } catch (error: unknown) {
      await stack.stop();
      throw error;
    }
    return stack;
  }

  /** A fresh database and a fresh api isolate (no cached connection or reads); the fake GitHub keeps running. */
  async reset(): Promise<void> {
    await this.api?.stop();
    this.api = null;
    await this.startApi();
  }

  async stop(): Promise<void> {
    await this.api?.stop();
    this.api = null;
    await this.fakePush?.stop();
    this.fakePush = null;
    await this.fake.stop();
  }

  /** The fake push service (Apple, FCM, Mozilla stand-in) of `nx run api:fake-push`, on this worker's own port. */
  private async startFakePush(): Promise<void> {
    this.fakePush = StackProcess.spawn(
      [
        'dev',
        '--config',
        FAKE_PUSH_CONFIG,
        '--ip',
        '127.0.0.1',
        '--port',
        String(this.ports.fakePush),
        '--inspector-port',
        String(this.ports.fakePushInspector),
        '--persist-to',
        join(this.dir, 'fake-push-state'),
        '--show-interactive-dev-session=false',
      ],
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

  private async startApi(): Promise<void> {
    const persist = join(this.dir, 'api-state');
    rmSync(persist, { recursive: true, force: true });
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
        persist,
      ],
      join(this.dir, 'migrate.log'),
    );
    this.api = StackProcess.spawn(
      [
        'dev',
        API_BUNDLE,
        '--config',
        API_CONFIG,
        '--env',
        'dev',
        '--ip',
        '127.0.0.1',
        '--port',
        String(this.ports.api),
        '--inspector-port',
        String(this.ports.apiInspector),
        '--persist-to',
        persist,
        '--show-interactive-dev-session=false',
        // The Dockerfile's local switches, plus the fake GitHub for the owner connection and owner writes.
        '--var',
        'ENVIRONMENT:local',
        '--var',
        'AUTH_MODE:local',
        '--var',
        'GITHUB_MOCK:true',
        '--var',
        'OWNER_GITHUB_LOGIN:geeera',
        '--var',
        `GITHUB_FAKE_ORIGIN:${this.fakeURL}`,
        '--var',
        `GITHUB_APP_CLIENT_ID:${FAKE_CLIENT_ID}`,
        '--var',
        `GITHUB_APP_CLIENT_SECRET:${FAKE_CLIENT_SECRET}`,
        '--var',
        // A throwaway key per run: it seals the fake owner token in this run's own database only.
        `TOKEN_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`,
        '--var',
        'ROUTINE_TOKEN_TEAM_CONSOLE:local-fake-routine',
        // Web push (#36) against the fake push service only, with this run's throwaway VAPID pair.
        '--var',
        `PUSH_FAKE_ORIGIN:${this.fakePushURL}`,
        '--var',
        `VAPID_PUBLIC_KEY:${this.vapid.publicKey}`,
        '--var',
        `VAPID_PRIVATE_KEY:${this.vapid.privateKey}`,
      ],
      join(this.dir, 'api.log'),
    );
    await waitForOk(`${this.baseURL}/api/v1/healthz`, this.api, `${this.name} api`);
  }
}
