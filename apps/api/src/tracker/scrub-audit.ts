import type { WorkerContext } from '@worker/core';
import { auditEventStatement, type TrackerProject } from '@worker/db';
import { auditActorOf } from '../auth/scope';
import type { ApiEnv } from '../env';

/**
 * The `tracker.scrubbed` audit row of an owner's scrub (#477), for the scrub's own batch: the masking and its record
 * land together or not at all. `details` names what was masked by number, id and field name; the text is never here.
 */
export function scrubAuditStatement(
  c: WorkerContext<ApiEnv>,
  project: TrackerProject,
  at: string,
  details: Readonly<Record<string, number | boolean | readonly number[] | readonly string[]>>,
): D1PreparedStatement {
  const actor = auditActorOf(c.get('identity'));
  return auditEventStatement(c.env.DB, {
    accountId: project.accountId,
    at,
    actorKind: actor.kind,
    actor: actor.actor,
    kind: 'tracker.scrubbed',
    target: project.slug,
    details,
    ipCountry: c.req.header('CF-IPCountry') ?? null,
  });
}
