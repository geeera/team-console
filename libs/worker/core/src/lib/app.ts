import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { WorkerBaseEnv } from './env';
import { createLogger, type LogSink, type Logger } from './logger';
import { problem } from './problem';

export interface WorkerVariables {
  requestId: string;
  logger: Logger;
}

export type WorkerHonoEnv<B extends WorkerBaseEnv = WorkerBaseEnv> = {
  Bindings: B;
  Variables: WorkerVariables;
};

export type WorkerContext<B extends WorkerBaseEnv = WorkerBaseEnv> = Context<WorkerHonoEnv<B>>;

export interface CreateWorkerAppOptions<B extends WorkerBaseEnv> {
  /** Appears on every log line, so the two Workers' logs can be told apart. */
  readonly service: string;
  /** Replaces the default 404 problem for paths the Worker does not own (e.g. hand a page to the assets binding). */
  readonly notFound?: (c: WorkerContext<B>) => Response | Promise<Response>;
  /** Test seam; production writes to the console, which Workers Logs collects. */
  readonly logSink?: LogSink;
}

/** Slugs for the statuses Hono itself raises (body limits, bad JSON); anything else is a plain `http-error`. */
const HTTP_EXCEPTION_SLUGS: Readonly<Partial<Record<number, string>>> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  429: 'rate-limited',
};

function loggerOf<B extends WorkerBaseEnv>(
  c: WorkerContext<B>,
  service: string,
  sink: LogSink | undefined,
): Logger {
  // Set by the middleware below; absent only if a request failed before it ran.
  return c.get('logger') ?? createLogger({ service, requestId: c.get('requestId') ?? 'none' }, sink);
}

/**
 * Hono app with the conventions both Workers share: request id in and out (`X-Request-Id`),
 * a per-request redacting logger, RFC 9457 bodies for 404 and 500. Routes are added by the caller.
 */
export function createWorkerApp<B extends WorkerBaseEnv>(
  options: CreateWorkerAppOptions<B>,
): Hono<WorkerHonoEnv<B>> {
  const app = new Hono<WorkerHonoEnv<B>>({ strict: false });

  app.use(requestId());
  app.use(async (c, next) => {
    c.set(
      'logger',
      createLogger({ service: options.service, requestId: c.get('requestId') }, options.logSink),
    );
    await next();
  });

  app.notFound((c) =>
    options.notFound === undefined
      ? problem(c, { type: 'not-found', title: 'Not Found', status: 404 })
      : options.notFound(c),
  );

  app.onError((error, c) => {
    const logger = loggerOf(c, options.service, options.logSink);
    if (error instanceof HTTPException) {
      const status: ContentfulStatusCode = error.status;
      logger.warn('request rejected', { status, method: c.req.method, path: c.req.path });
      return problem(c, {
        type: HTTP_EXCEPTION_SLUGS[status] ?? 'http-error',
        title: error.message || 'Request rejected',
        status,
      });
    }
    // The stack goes to the log only; the body carries just the request id to find it by.
    logger.error('unhandled error', { error, method: c.req.method, path: c.req.path });
    return problem(c, { type: 'internal', title: 'Internal Server Error', status: 500 });
  });

  return app;
}
