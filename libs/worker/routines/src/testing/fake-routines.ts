/**
 * Test and local-run only: a stand-in for `POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire`.
 * The api specs use it through `fetch`; `nx run api:fake-routines` serves it as a local Worker, so "Run now" runs
 * end to end without ever calling Anthropic. Every value it hands out is fake.
 */

/** How the next fire ends (one-shot, in order). */
export type FakeRoutineOutcome =
  | 'ok'
  | 'rate-limited'
  | 'rate-limited-no-header'
  | 'paused'
  | 'bad-request'
  | 'unauthorized'
  | 'not-found'
  | 'forbidden'
  | 'unavailable'
  | 'hang';

export interface FakeFire {
  readonly routineId: string;
  readonly text: string;
  readonly anthropicVersion: string | null;
  readonly hasBetaHeader: boolean;
  /** Whether the bearer had a trigger token's shape; the value itself is never kept. */
  readonly bearerShaped: boolean;
  readonly outcome: FakeRoutineOutcome;
  readonly at: string;
}

export interface FakeRoutinesOptions {
  /** How long `hang` waits before answering; longer than the client's deadline. */
  readonly hangMs?: number;
}

const FIRE_PATH = /^\/v1\/claude_code\/routines\/([^/]+)\/fire$/;
const TOKEN_SHAPE = /^Bearer sk-ant-[A-Za-z0-9_-]{8,}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function error(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { type: 'error', error: { type, message } }, headers);
}

export class FakeRoutines {
  readonly fires: FakeFire[] = [];
  private readonly queue: FakeRoutineOutcome[] = [];
  private session = 0;

  constructor(private readonly options: FakeRoutinesOptions = {}) {}

  /** `fetch` for the Worker: the real api.anthropic.com URL. */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> =>
    this.handle(new Request(input, init));

  /** Queues how the next fires end; without one a fire succeeds. */
  next(...outcomes: FakeRoutineOutcome[]): void {
    this.queue.push(...outcomes);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = FIRE_PATH.exec(url.pathname);
    if (request.method !== 'POST' || match === null) {
      return error(404, 'not_found_error', 'Not found');
    }
    const bearerShaped = TOKEN_SHAPE.test(request.headers.get('authorization') ?? '');
    let body: { text?: unknown };
    try {
      body = (await request.json()) as { text?: unknown };
    } catch {
      return error(400, 'invalid_request_error', 'Body must be JSON');
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const queued = this.queue.shift() ?? 'ok';
    const outcome: FakeRoutineOutcome = bearerShaped ? queued : 'unauthorized';
    this.fires.push({
      routineId: decodeURIComponent(match[1] ?? ''),
      text,
      anthropicVersion: request.headers.get('anthropic-version'),
      hasBetaHeader: request.headers.has('anthropic-beta'),
      bearerShaped,
      outcome,
      at: new Date().toISOString(),
    });
    switch (outcome) {
      case 'ok': {
        this.session += 1;
        const id = `session_fake${String(this.session).padStart(4, '0')}`;
        return json(200, {
          type: 'routine_fire',
          claude_code_session_id: id,
          claude_code_session_url: `https://claude.ai/code/${id}`,
        });
      }
      case 'rate-limited':
        return error(429, 'rate_limit_error', 'Rate limited', { 'Retry-After': '1200' });
      case 'rate-limited-no-header':
        return error(429, 'rate_limit_error', 'Rate limited');
      case 'paused':
        return error(400, 'invalid_request_error', 'The routine is paused');
      case 'bad-request':
        return error(400, 'invalid_request_error', 'text is too long');
      case 'unauthorized':
        return error(401, 'authentication_error', 'Invalid bearer token');
      case 'not-found':
        return error(404, 'not_found_error', 'Routine not found');
      case 'forbidden':
        return error(403, 'permission_error', 'Forbidden');
      case 'unavailable':
        return error(503, 'overloaded_error', 'Overloaded');
      case 'hang':
        await new Promise((resolve) => setTimeout(resolve, this.options.hangMs ?? 15_000));
        return error(504, 'timeout_error', 'Timed out');
    }
  }
}
