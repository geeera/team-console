import { Hono } from 'hono';
import { checkCreatePrLinkInput, isRecord, type PrLinkDto } from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { ItemEventsRepo, type ItemEventRecord, type ProjectRow } from '@worker/db';
import { isBranchName, pullRequestUrlOf } from '@worker/vcs-github';
import { DEVELOPER_ROLES } from '../../auth/job-roles';
import { holdsItem } from '../../auth/policy';
import { trackerAccess, trackerProjectOfContext } from '../../auth/tracker-access.middleware';
import type { ApiEnv } from '../../env';
import type { ApiGitHub } from '../../github';
import { repoOf } from '../../projects/lookup';
import type { OwnerConnectionSource } from '../../projects/owner-connection';
import { findPullRequest } from '../../read-models/pull-request-sync';
import { repoIdOf } from '../../read-models/repo-id';
import { bodySecretRefusal } from '../../tracker/body-secret';
import { invalid, itemClosed, itemOf } from '../../tracker/context';
import { SMALL_WRITE_MAX_BYTES, writeLimit } from '../../tracker/http';
import { idempotent } from '../../tracker/idempotency';
import { trackerWriteContextOf } from '../../tracker/write-context';

type Context = WorkerContext<ApiEnv>;

interface PrLink {
  readonly number: number;
  readonly url: string;
  readonly headRef: string;
}

/** The link a `pr-linked` event carries (`after`), or `null` for a shape this version did not write. */
function prLinkOf(event: ItemEventRecord): PrLink | null {
  const after = event.after;
  if (
    event.kind !== 'pr-linked' ||
    !isRecord(after) ||
    typeof after['number'] !== 'number' ||
    typeof after['url'] !== 'string' ||
    typeof after['headRef'] !== 'string'
  ) {
    return null;
  }
  return { number: after['number'], url: after['url'], headRef: after['headRef'] };
}

function prLinkDtoOf(event: ItemEventRecord): PrLinkDto {
  const link = prLinkOf(event);
  if (link === null) {
    // Only this route writes `pr-linked` through the API; a row it cannot read back is our data, not input.
    throw new Error('a pr-linked event without its link');
  }
  return { ...link, linkedAt: event.at, linkedBy: { kind: event.actorKind, name: event.actor } };
}

function respond(c: Context, event: ItemEventRecord | null, status: 200 | 201): Response {
  if (event === null) {
    return problem(c, { type: 'item-not-found', title: 'Item not found', status: 404 });
  }
  c.header('Cache-Control', 'no-store');
  return c.json(prLinkDtoOf(event), status);
}

/**
 * `null` when the provider has pull request `number` with head branch `headRef` (#529); else the route's answer:
 * 422 `pr-link-invalid` on `number` (no such pull request) or `headRef` (another head), 409 `repo-id-unknown`. A
 * provider outage or rate limit throws the adapter's `VcsError` (502 / 429 with `Retry-After`), which `idempotent`
 * turns into a released key, so the client retries under the same one.
 */
async function verifiedOnProvider(
  c: Context,
  github: ApiGitHub,
  owners: OwnerConnectionSource,
  registry: ProjectRow,
  number: number,
  headRef: string,
): Promise<Response | null> {
  const repo = repoOf(c, registry);
  if (repo instanceof Response) {
    return repo;
  }
  const repoId = await repoIdOf(c, github, owners, registry, repo);
  if (repoId instanceof Response) {
    return repoId;
  }
  const pull = await findPullRequest(github, c.env, repo, repoId, number);
  if (pull === null) {
    return invalid(
      c,
      'pr-link-invalid',
      'number',
      'number is not a pull request of this project’s repository',
    );
  }
  if (pull.headRef !== headRef) {
    return invalid(c, 'pr-link-invalid', 'headRef', 'headRef is not the pull request’s head branch');
  }
  return null;
}

/**
 * Pull request links (#445, formerly `backlog link-pr`): a `pr-linked` item event `{ number, url, headRef }`, until
 * Phase 2 gives the link a `pull_requests` row. The developer who holds the item or the orchestrator links it (the
 * route matrix, then `item-not-held`); the URL must be the project's own pull request of that number, and the event
 * stores the URL the server built. Linking the same pull request again with the same branch answers the first link
 * (200, nothing written); with another branch it is 409 `pr-link-conflict`. A new link is first checked on the
 * provider (#529, `verifiedOnProvider`), and migration 0025's unique index keeps two concurrent links to one event:
 * the loser answers like a repeat.
 */
export function createTrackerPrLinkRoutes(
  github: ApiGitHub,
  owners: OwnerConnectionSource,
): Hono<WorkerHonoEnv<ApiEnv>> {
  const guard = trackerAccess('POST /api/v1/projects/:slug/items/:key/pr-links');
  return new Hono<WorkerHonoEnv<ApiEnv>>().post(
    '/:slug/items/:key/pr-links',
    guard,
    writeLimit(SMALL_WRITE_MAX_BYTES),
    async (c) => {
      const context = await trackerWriteContextOf(c);
      if (context instanceof Response) {
        return context;
      }
      const { project, actor, policyActor, write } = context;
      if (policyActor.kind !== 'job') {
        // The matrix row admits jobs only; anything else reaching here is a bug, never an open door.
        throw new Error('a pr link reached the handler without a job actor');
      }
      const item = await itemOf(c, project);
      if (item instanceof Response) {
        return item;
      }
      if (DEVELOPER_ROLES.has(policyActor.role) && !holdsItem(policyActor, item.number)) {
        c.get('logger').warn('tracker pr link refused', { type: 'pr-link-role', reason: 'item-not-held' });
        return problem(c, {
          type: 'pr-link-role',
          title: 'Forbidden',
          status: 403,
          detail: 'A developer links a pull request to an item it holds',
          extensions: { reason: 'item-not-held' },
        });
      }
      const events = new ItemEventsRepo(c.env.DB);
      return idempotent(
        c,
        write,
        async (ref, status) =>
          respond(c, await events.find(item.id, Number(ref)), status === 201 ? 201 : 200),
        async (complete) => {
          const input = checkCreatePrLinkInput(write.body);
          if (!input.ok) {
            return invalid(c, 'pr-link-invalid', input.field, input.detail);
          }
          const { number, headRef } = input.value;
          if (!isBranchName(headRef)) {
            return invalid(c, 'pr-link-invalid', 'headRef', 'headRef must be a git branch name');
          }
          const secret = bodySecretRefusal(c, policyActor, { headRef });
          if (secret !== null) {
            return secret;
          }
          const registry = trackerProjectOfContext(c);
          if (registry.provider !== 'github') {
            return problem(c, {
              type: 'pr-link-provider',
              title: 'Pull request links are not available for this provider yet',
              status: 409,
              detail: 'Only GitHub pull requests are linked until the VCS adapter covers this provider',
            });
          }
          const url = pullRequestUrlOf(registry.repo, number);
          // GitHub names are case-insensitive; the stored URL is the server's, never the client's spelling.
          if (input.value.url.toLowerCase() !== url.toLowerCase()) {
            return invalid(
              c,
              'pr-link-invalid',
              'url',
              'url is not a pull request of this project’s repository',
            );
          }
          if (item.closedAt !== null) {
            return itemClosed(c);
          }
          const alreadyLinked = async (existing: ItemEventRecord): Promise<Response> => {
            if (prLinkOf(existing)?.headRef !== headRef) {
              return problem(c, {
                type: 'pr-link-conflict',
                title: 'The pull request is linked with another branch',
                status: 409,
                detail: 'This pull request is already linked to the item with a different head branch',
              });
            }
            await c.env.DB.batch([complete(200, 'event', { value: String(existing.id) })]);
            return respond(c, existing, 200);
          };
          const existing = await events.findPrLink(item.id, number);
          if (existing !== null) {
            return alreadyLinked(existing);
          }
          // Only a new link asks the provider; a refusal or a provider failure writes nothing and frees the key.
          const verified = await verifiedOnProvider(c, github, owners, registry, number, headRef);
          if (verified !== null) {
            return verified;
          }
          const at = new Date().toISOString();
          const isWritten = await events.linkPr(item.id, { number, url, headRef }, actor, at, [
            complete(201, 'event', { newestEventOf: item.id }),
          ]);
          if (!isWritten) {
            // A concurrent link of the same pull request won (migration 0025's index): answer it as a repeat.
            const winner = await events.findPrLink(item.id, number);
            if (winner === null) {
              throw new Error('a pr link lost the unique index to a link that does not exist');
            }
            c.get('logger').info('tracker pr link lost a race', { slug: project.slug, pr: number });
            return alreadyLinked(winner);
          }
          c.get('logger').info('tracker pr linked', { slug: project.slug, number: item.number, pr: number });
          return respond(c, await events.findPrLink(item.id, number), 201);
        },
      );
    },
  );
}
