import { Hono } from 'hono';
import {
  AUDIT_PAGE_MAX,
  entitlementsOf,
  isUlid,
  type AccountDto,
  type AccountMemberDto,
  type AuditEventListDto,
} from '@shared/contracts';
import { problem, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { AccountsRepo, AuditRepo, type AccountRecord } from '@worker/db';
import { roleIn } from '../auth/scope';
import type { ApiEnv } from '../env';

type Context = WorkerContext<ApiEnv>;

const CURSOR = /^[1-9][0-9]{0,15}$/;
const PAGE_DEFAULT = 50;

function accountNotFound(c: Context): Response {
  return problem(c, { type: 'account-not-found', title: 'Account not found', status: 404 });
}

/**
 * The account behind `:id` for an **owner** of it (ADR 0008 "Identity, routes and the matrix": account routes are
 * owner-of-account only). A non-member gets the same 404 as an id that does not exist, so no account is enumerable;
 * a `member` knows the account exists and gets 403 `account-owner-only`.
 */
export async function ownedAccountOf(c: Context): Promise<AccountRecord | Response> {
  const id = c.req.param('id') ?? '';
  const role = isUlid(id) ? roleIn(c.get('identity'), c.env, id) : null;
  if (role === null) {
    c.get('logger').warn('account route refused', {
      reason: 'not-a-member',
      identity: c.get('identity').kind,
    });
    return accountNotFound(c);
  }
  if (role !== 'owner') {
    c.get('logger').warn('account route refused', { reason: role });
    return problem(c, {
      type: 'account-owner-only',
      title: 'Forbidden',
      status: 403,
      detail: 'Only an owner of the account reads its settings, members and audit',
    });
  }
  const account = await new AccountsRepo(c.env.DB).findById(id);
  // A membership of an account that is gone: the row was deleted under it (T-6); the same answer as unknown.
  return account ?? accountNotFound(c);
}

function accountDtoOf(account: AccountRecord): AccountDto {
  return {
    id: account.id,
    slug: account.slug,
    name: account.name,
    plan: account.plan,
    entitlements: entitlementsOf(account),
    createdAt: account.createdAt,
    suspendedAt: account.suspendedAt,
  };
}

/**
 * `GET /api/v1/accounts/:id/{settings,members,audit}` (T-2, #466; ADR 0008 decisions 5 and 6). Reads only: members,
 * invites and roles are written by T-3. `Cache-Control: no-store` comes from `createWorkerApp`.
 */
export function createAccountRoutes(): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .get('/:id/settings', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      return c.json(accountDtoOf(account));
    })

    .get('/:id/members', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const members: AccountMemberDto[] = (await new AccountsRepo(c.env.DB).membersOf(account.id)).map(
        (member) => ({
          userId: member.userId,
          login: member.login,
          avatarUrl: member.avatarUrl,
          role: member.role,
          joinedAt: member.joinedAt,
        }),
      );
      return c.json({ members });
    })

    .get('/:id/audit', async (c) => {
      const account = await ownedAccountOf(c);
      if (account instanceof Response) {
        return account;
      }
      const before = c.req.query('before');
      const limit = c.req.query('limit') ?? String(PAGE_DEFAULT);
      if ((before !== undefined && !CURSOR.test(before)) || !/^[1-9][0-9]{0,2}$/.test(limit)) {
        return problem(c, {
          type: 'query-invalid',
          title: 'Invalid request',
          status: 400,
          detail: `before is the cursor of the previous page; limit is 1 to ${String(AUDIT_PAGE_MAX)}`,
        });
      }
      const page = await new AuditRepo(c.env.DB).listForAccount(
        account.id,
        before === undefined ? null : Number(before),
        Number(limit),
      );
      const body: AuditEventListDto = {
        events: page.events.map((event) => ({
          id: event.id,
          at: event.at,
          actorKind: event.actorKind,
          actor: event.actor,
          kind: event.kind,
          target: event.target,
          details: event.details,
        })),
        nextCursor: page.nextCursor,
      };
      return c.json(body);
    });
}
