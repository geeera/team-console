import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { NOT_SNOOZED, SNOOZE_MAX_DAYS, type SnoozeDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ProjectsRepo, snoozeOf, type SnoozeChange } from '@worker/db';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import { jsonBody } from '../json-body';
import { findProject, projectNotFound } from '../projects/lookup';

type Context = WorkerContext<ApiEnv>;

// Two short fields; anything bigger is not ours.
const MAX_BODY_BYTES = 1024;
const MAX_SNOOZE_MS = SNOOZE_MAX_DAYS * 24 * 60 * 60 * 1000;
// A full date-time with an explicit zone: a bare date or a zone-less time would mean a different instant per reader.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The validated change (`until` normalised to ISO 8601 UTC), or why the body is refused. */
export function parseSnooze(body: unknown, nowMs: number): SnoozeChange | string {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'until' && key !== 'allowsUrgent')) {
    return 'The body must be {"until": string | null, "allowsUrgent": boolean}';
  }
  const { until, allowsUrgent } = body;
  if (typeof allowsUrgent !== 'boolean') {
    return 'allowsUrgent must be a boolean';
  }
  if (until === null) {
    return { until: null, allowsUrgent };
  }
  if (typeof until !== 'string' || !ISO_DATE_TIME.test(until) || !Number.isFinite(Date.parse(until))) {
    return 'until must be an ISO 8601 date-time with a zone, or null';
  }
  const untilMs = Date.parse(until);
  if (untilMs <= nowMs) {
    return 'until must be in the future';
  }
  if (untilMs - nowMs > MAX_SNOOZE_MS) {
    return `until must be at most ${String(SNOOZE_MAX_DAYS)} days away`;
  }
  return { until: new Date(untilMs).toISOString(), allowsUrgent };
}

function invalid(c: Context, detail: string): Response {
  return problem(c, { type: 'validation', title: 'Invalid request', status: 422, detail });
}

/**
 * Snoozed notifications (#221, architect note on #29 §5 and its amendment 6): D1 only, no GitHub call, idempotent by
 * nature, so no replay window. Owner-only: the dev/stage service identity must not be able to mute the owner's
 * pushes. The hooks Worker reads the same columns.
 */
export function createNotificationsRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      problem(c as Context, { type: 'payload-too-large', title: 'Payload Too Large', status: 413 }),
  });

  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .put('/:slug/notifications/snooze', ownerOnlyMiddleware, limit, async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const nowMs = github.now();
      const change = parseSnooze(await jsonBody(c), nowMs);
      if (typeof change === 'string') {
        return invalid(c, change);
      }
      const row = await new ProjectsRepo(c.env.DB).setSnooze(
        project.slug,
        change,
        new Date(nowMs).toISOString(),
      );
      if (row === null) {
        return projectNotFound(c);
      }
      c.get('logger').info('notifications snoozed', {
        slug: project.slug,
        forever: change.until === null,
        allowsUrgent: change.allowsUrgent,
      });
      const body: SnoozeDto = snoozeOf(row, nowMs);
      c.header('Cache-Control', 'no-store');
      return c.json(body);
    })

    .delete('/:slug/notifications/snooze', ownerOnlyMiddleware, async (c) => {
      const project = await findProject(c, c.req.param('slug'));
      if (project === null) {
        return projectNotFound(c);
      }
      const row = await new ProjectsRepo(c.env.DB).clearSnooze(project.slug);
      if (row === null) {
        return projectNotFound(c);
      }
      c.get('logger').info('notifications back on', { slug: project.slug });
      c.header('Cache-Control', 'no-store');
      return c.json(NOT_SNOOZED);
    });
}
