export interface StackPorts {
  readonly api: number;
  readonly fake: number;
  readonly apiInspector: number;
  readonly fakeInspector: number;
  readonly fakePush: number;
  readonly fakePushInspector: number;
}

/** Where a run's ports start when `E2E_PORT_BASE` is not set: CI, and one local run at a time. */
export const DEFAULT_PORT_BASE = 18_700;
/** The ports of one e2e run (a stream): `[base, base + STREAM_PORT_SPAN)`. */
export const STREAM_PORT_SPAN = 100;
/** The ports of one Playwright worker slot inside its stream: six in use, four spare. */
export const PORTS_PER_WORKER = 10;
export const WORKER_SLOTS_PER_STREAM = STREAM_PORT_SPAN / PORTS_PER_WORKER;

const LOWEST_PORT_BASE = 1_100;
const HIGHEST_PORT_BASE = 65_400;

/**
 * The first port of this run's range (#982). Every run owns the hundred ports from its base, and a base is a multiple
 * of 100, so two runs with different bases can never share a port — a server's or an inspector's. A value that is
 * not such a base throws: falling back to the default would start this run on another run's ports.
 */
export function streamPortBase(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT_BASE;
  }
  const base = Number(raw);
  if (
    !Number.isInteger(base) ||
    base % STREAM_PORT_SPAN !== 0 ||
    base < LOWEST_PORT_BASE ||
    base > HIGHEST_PORT_BASE
  ) {
    throw new Error(
      `E2E_PORT_BASE=${raw} is not a port base: use a multiple of ${STREAM_PORT_SPAN} from ${LOWEST_PORT_BASE} to ` +
        `${HIGHEST_PORT_BASE} (each run owns the ${STREAM_PORT_SPAN} ports from its base)`,
    );
  }
  return base;
}

/**
 * Ten ports per Playwright worker slot, so parallel workers never share a server or a database: api, fake GitHub,
 * api inspector, fake GitHub inspector, fake push, fake push inspector at offsets 0–5, the rest spare. The
 * inspectors sit inside the run's own range too: a fixed inspector port was what two runs on one machine collided on.
 */
export function portsFor(
  parallelIndex: number,
  rawBase: string | undefined = process.env['E2E_PORT_BASE'],
): StackPorts {
  if (!Number.isInteger(parallelIndex) || parallelIndex < 0 || parallelIndex >= WORKER_SLOTS_PER_STREAM) {
    throw new Error(
      `No ports for worker slot ${parallelIndex}: a run has ${WORKER_SLOTS_PER_STREAM} slots of ${PORTS_PER_WORKER} ports`,
    );
  }
  const first = streamPortBase(rawBase) + parallelIndex * PORTS_PER_WORKER;
  return {
    api: first,
    fake: first + 1,
    apiInspector: first + 2,
    fakeInspector: first + 3,
    fakePush: first + 4,
    fakePushInspector: first + 5,
  };
}

/**
 * `-<base>` for a run with its own `E2E_PORT_BASE`, nothing for the default: the suffix of the directories a run
 * writes (stack state and logs, Playwright's output), so two runs in one checkout do not clear each other's.
 */
export function streamSuffix(rawBase: string | undefined = process.env['E2E_PORT_BASE']): string {
  return rawBase === undefined || rawBase === '' ? '' : `-${streamPortBase(rawBase)}`;
}
