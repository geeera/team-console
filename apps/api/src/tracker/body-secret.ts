import { withoutInvisibles } from '@shared/plain-text';
import { findSecret } from '@shared/redaction';
import { problem, type WorkerContext } from '@worker/core';
import type { PolicyActor } from '../auth/policy';
import type { ApiEnv } from '../env';

// Judged as the reader sees it: an invisible character (ZWJ included) inside a token does not hide it.
const visibleText = (text: string): string => withoutInvisibles(text).replace(/\u200d/g, '');

/**
 * A job's free text never stores a secret (#462, #446 decision 5): `item_events` keeps every `before`/`after` and
 * comments are append-only, so a token a job pastes would outlive its rotation. The text a job writes is refused
 * (422 `body-secret`, naming the member and the kind of secret, never the value) when it matches a pattern of
 * `@shared/redaction`. The owner's own text is not judged: it is not a job's output.
 *
 * `texts`: the request members that carry free text, `undefined`/`null` for the ones the request leaves out.
 */
export function bodySecretRefusal(
  c: WorkerContext<ApiEnv>,
  actor: PolicyActor,
  texts: Readonly<Record<string, string | null | undefined>>,
): Response | null {
  if (actor.kind !== 'job') {
    return null;
  }
  for (const [field, text] of Object.entries(texts)) {
    const kind = typeof text === 'string' ? findSecret(visibleText(text)) : null;
    if (kind !== null) {
      c.get('logger').warn('tracker write refused', { type: 'body-secret', field, kind, role: actor.role });
      return problem(c, {
        type: 'body-secret',
        title: 'The text carries a secret',
        status: 422,
        detail: 'Remove the credential from the text; job output never stores one',
        extensions: { field, kind },
      });
    }
  }
  return null;
}
