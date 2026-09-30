export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const REDACTED = '[redacted]';
/** Header names (lower-case) whose values are credentials, whatever the caller thinks they are. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'cf-access-jwt-assertion',
  'cookie',
  'set-cookie',
]);
/**
 * GitHub tokens (classic, fine-grained, OAuth, installation `ghs_`, user `ghu_`, refresh `ghr_`), JWTs (`eyJ`
 * is base64url `{"`, which also covers the app JWT) and PEM private keys, whole or cut off: a credential that
 * slipped into a message or an error still never lands in a log (ADR 0003 decision 8).
 */
const TOKEN_PATTERN =
  /(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|PRIVATE KEY/g;
/**
 * The query of any absolute URL in a log string: an OAuth callback's `code` and `state`, or a token someone put
 * in a query, never reach a log (ADR 0003 decision 3). Paths stay, so a line still says which route it was.
 */
const URL_QUERY_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi;
/** Deep enough for headers and nested error causes; stops runaway or cyclic structures. */
const MAX_DEPTH = 6;

function redactString(value: string): string {
  return value.replace(TOKEN_PATTERN, REDACTED).replace(URL_QUERY_PATTERN, `$1?${REDACTED}`);
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (value instanceof Error) {
    return redactValue(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: value.cause,
      },
      depth,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  const entries =
    value instanceof Headers || value instanceof Map
      ? Array.from(value.entries())
      : Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(item, depth + 1);
  }
  return result;
}

/** Strips credentials from anything about to be logged. Exported so tests and callers can rely on one rule set. */
export function redact(fields: unknown): unknown {
  return redactValue(fields, 0);
}

function serialise(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch (error: unknown) {
    // A BigInt or a getter that throws must not take the log line (and the request) down with it.
    const reason = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      level: 'error',
      message: 'log line could not be serialised',
      reason: redactString(reason),
    });
  }
}

/**
 * One JSON line per call so Workers Logs can filter on fields. `context` (service, requestId)
 * is repeated on every line: the request id is the only correlation key we have.
 */
export function createLogger(context: LogFields, sink: LogSink = (line) => console.log(line)): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    const redactedFields = fields === undefined ? {} : (redact(fields) as Record<string, unknown>);
    sink(
      serialise({
        level,
        message: redactString(message),
        ...(redact(context) as Record<string, unknown>),
        ...redactedFields,
        ts: new Date().toISOString(),
      }),
    );
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
