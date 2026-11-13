import { redactSecrets } from '@shared/redaction';

/**
 * Threat model C2 "events leak a token": every body the runner sends to the console passes the shared redactor
 * (`loose`, the log-grade mode), keys and string values alike, at any depth. The enrolment body is the one exception
 * — it carries the one-time code on purpose — and does not go through this function.
 */
export function redactJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, 'loose');
  }
  if (Array.isArray(value)) {
    return value.map(redactJson);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactSecrets(key, 'loose'), redactJson(entry)]),
    );
  }
  return value;
}

/** A JSON body as the console receives it: serialised after redaction, never before. */
export function redactedJsonBody(value: unknown): string {
  return JSON.stringify(redactJson(value));
}
