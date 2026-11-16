import { redactSecrets, type RedactionMode } from '@shared/redaction';

/**
 * Threat model C2 "events leak a token": every body the runner sends to the console passes the shared redactor,
 * keys and string values alike, at any depth. The runner's own bodies (events, heartbeat, finish) use `loose`, the
 * log-grade mode. A job's proxied project writes use `strict` (#583): it still masks every whole token shape, but
 * prose that only names a prefix (`PRIVATE KEY`, `sk-ant-…`) reaches the console as the job wrote it, so a finding
 * or runbook the job stores is never silently rewritten. The enrolment body is the one exception — it carries the
 * one-time code on purpose — and does not go through this function.
 */
export function redactJson(value: unknown, mode: RedactionMode = 'loose'): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, mode);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => redactJson(entry, mode));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactSecrets(key, mode), redactJson(entry, mode)]),
    );
  }
  return value;
}

/** A JSON body as the console receives it: serialised after redaction, never before. */
export function redactedJsonBody(value: unknown, mode: RedactionMode = 'loose'): string {
  return JSON.stringify(redactJson(value, mode));
}
