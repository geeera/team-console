import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  GITHUB_AUTHORIZED_APPS_URL,
  GITHUB_SETTINGS_PATH,
  type GitHubDisconnectIncompleteDto,
  type GitHubConnectOutcome,
  type GitHubConnectStartDto,
  type GitHubConnectionDto,
} from '@shared/contracts';
import { randomHex, timingSafeEqualText, type WorkerContext, type WorkerHonoEnv } from '@worker/core';
import { OwnerConnectionsRepo } from '@worker/db';
import { GitHubError, pkceChallengeOf, type GitHubOAuth, type UserTokenPair } from '@worker/github';
import { ownerOnlyMiddleware } from '../auth/owner-only.middleware';
import type { ApiEnv } from '../env';
import type { ApiGitHub } from '../github';
import {
  CLEAR_ATTEMPT_COOKIE,
  OAUTH_COOKIE,
  openAttemptCookie,
  sealAttemptCookie,
} from '../owner/oauth-cookie';
import { loadOwnerKeys } from '../owner/owner-keys';
import { consoleAppNameFor } from '../projects/repository-checks';

export const CALLBACK_PATH = '/api/v1/github/callback';

// 256 bits each: `state` well above the 128 the threat model asks for; hex is inside RFC 7636's verifier alphabet.
const RANDOM_BYTES = 32;
const STATE_PATTERN = /^[0-9a-f]{64}$/;
// GitHub's codes are 20 hex characters today; anything code-shaped is passed on, anything else never leaves.
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * `redirect_uri`, identical for connect and callback: the host Cloudflare routed this request on (every hostname
 * that reaches this Worker is its own and sits behind Access), https outside a local run. The `Host` and
 * `X-Forwarded-Host` headers are never read, and GitHub accepts only the callback URL registered on the app.
 */
export function callbackUrlFor(requestUrl: string, environment: string): string {
  const url = new URL(requestUrl);
  const origin = environment === 'local' ? url.origin : `https://${url.host}`;
  return `${origin}${CALLBACK_PATH}`;
}

function callbackUrlOf(c: WorkerContext<ApiEnv>): string {
  return callbackUrlFor(c.req.url, c.env.ENVIRONMENT);
}

/** Back to Settings with the outcome; the target is fixed — nothing from the request picks it. */
function backToSettings(outcome: GitHubConnectOutcome, login?: string): Response {
  const query = new URLSearchParams({ github: outcome });
  if (login !== undefined) {
    query.set('login', login);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GITHUB_SETTINGS_PATH}?${query.toString()}`,
      'Set-Cookie': CLEAR_ATTEMPT_COOKIE,
      'Referrer-Policy': 'no-referrer',
      ...NO_STORE,
    },
  });
}

/** Revokes a grant we will not keep; a failure is logged (the grant stays live at GitHub) but decides nothing. */
async function revokeUnwanted(
  c: WorkerContext<ApiEnv>,
  oauth: GitHubOAuth,
  accessToken: string,
): Promise<boolean> {
  try {
    return (await oauth.revokeGrant(accessToken)) === 'revoked';
  } catch (error: unknown) {
    if (!(error instanceof GitHubError)) {
      throw error;
    }
    c.get('logger').error('owner connect: could not revoke a grant that is not kept', {
      problem: error.problem.type,
      githubStatus: error.githubStatus,
    });
    return false;
  }
}

/**
 * The owner connection (ADR 0003 decision 3, #59). All four routes sit behind the Access JWT middleware and refuse
 * the service identity (#85); `connect`
 * and `DELETE connection` also behind the CSRF middleware. The callback is a top-level GET from GitHub, protected by
 * Access, the sealed single-use cookie, `state` and PKCE, and the owner login check.
 */
export function createGitHubConnectionRoutes(github: ApiGitHub): Hono<WorkerHonoEnv<ApiEnv>> {
  return new Hono<WorkerHonoEnv<ApiEnv>>()
    .use('*', ownerOnlyMiddleware)
    .post('/connect', async (c) => {
      const oauth = github.oauth(c.env);
      // Checked now so a Worker without OWNER_GITHUB_LOGIN answers 503 before the owner is sent to GitHub.
      github.ownerLogin(c.env);
      const keys = await loadOwnerKeys(c.env.TOKEN_ENCRYPTION_KEY, c.env.ENVIRONMENT);
      const state = randomHex(RANDOM_BYTES);
      const verifier = randomHex(RANDOM_BYTES);
      const cookie = await sealAttemptCookie(keys.stateKey, c.env.ENVIRONMENT, {
        state,
        verifier,
        issuedAt: github.now(),
      });
      const body: GitHubConnectStartDto = {
        authorizeUrl: oauth.authorizeUrl({
          redirectUri: callbackUrlOf(c),
          state,
          codeChallenge: await pkceChallengeOf(verifier),
        }),
      };
      c.get('logger').info('owner connect started');
      return c.json(body, 200, { 'Set-Cookie': cookie, ...NO_STORE });
    })
    .get('/callback', async (c) => {
      const logger = c.get('logger');
      // Read before anything can fail: the answer always clears the cookie, whatever the outcome.
      const cookie = getCookie(c, OAUTH_COOKIE);
      const refuse = (reason: string, fields: Record<string, unknown> = {}): Response => {
        logger.warn('owner connect refused', { reason, ...fields });
        return backToSettings('failed');
      };

      const declined = c.req.query('error');
      if (declined !== undefined) {
        const error = ERROR_CODE_PATTERN.test(declined) ? declined : 'invalid';
        logger.info('owner connect declined on GitHub', { error });
        return backToSettings(error === 'access_denied' ? 'denied' : 'failed');
      }

      let oauth: GitHubOAuth;
      let ownerLogin: string;
      let keys: Awaited<ReturnType<typeof loadOwnerKeys>>;
      try {
        oauth = github.oauth(c.env);
        ownerLogin = github.ownerLogin(c.env);
        keys = await loadOwnerKeys(c.env.TOKEN_ENCRYPTION_KEY, c.env.ENVIRONMENT);
      } catch (error: unknown) {
        if (error instanceof GitHubError) {
          return refuse('misconfigured', { detail: error.problem.detail });
        }
        throw error;
      }

      const now = github.now();
      const check = await openAttemptCookie(keys.stateKey, c.env.ENVIRONMENT, cookie, now);
      if (!check.ok) {
        return refuse(
          check.reason,
          check.reason === 'cookie-unreadable' ? { securitySignal: 'owner-connect-tampered' } : {},
        );
      }
      const state = c.req.query('state') ?? '';
      const code = c.req.query('code') ?? '';
      if (!STATE_PATTERN.test(state) || !timingSafeEqualText(state, check.attempt.state)) {
        return refuse('state-mismatch', { securitySignal: 'owner-connect-tampered' });
      }
      if (!CODE_PATTERN.test(code)) {
        return refuse('code-missing');
      }
      // A cookie from before the current connection was made has been used already (or belongs to an older try).
      const current = await new OwnerConnectionsRepo(c.env.DB).find(c.env.ENVIRONMENT);
      if (current !== null && Date.parse(current.connected_at) >= check.attempt.issuedAt) {
        return refuse('replayed', { securitySignal: 'owner-connect-replayed' });
      }

      let pair: UserTokenPair;
      try {
        const exchanged = await oauth.exchangeCode(code, check.attempt.verifier, callbackUrlOf(c));
        if (exchanged.kind === 'refused') {
          return refuse('code-refused', { error: exchanged.error });
        }
        if (exchanged.kind === 'non-expiring') {
          const revoked =
            exchanged.accessToken === null ? false : await revokeUnwanted(c, oauth, exchanged.accessToken);
          logger.error('owner connect refused: the app issues non-expiring user tokens', {
            fix: 'turn on "Expire user authorization tokens" in the GitHub App settings',
            revoked,
          });
          return backToSettings('failed');
        }
        pair = exchanged.pair;
      } catch (error: unknown) {
        if (error instanceof GitHubError) {
          return refuse('exchange-failed', { problem: error.problem.type, githubStatus: error.githubStatus });
        }
        throw error;
      }

      // From here a live grant exists: every way out either stores it or revokes it.
      try {
        const user = await oauth.fetchUser(pair.accessToken);
        if (user.login.toLowerCase() !== ownerLogin.toLowerCase()) {
          const revoked = await revokeUnwanted(c, oauth, pair.accessToken);
          logger.warn('owner connect refused: GitHub login is not the owner', {
            securitySignal: 'owner-login-refused',
            login: user.login,
            revoked,
          });
          return backToSettings('wrong-account', user.login);
        }
        const connection = await github.ownerConnection(c.env, logger);
        await connection.connect(user, pair);
        logger.info('owner connected', { login: user.login });
        return backToSettings('connected');
      } catch (error: unknown) {
        const revoked = await revokeUnwanted(c, oauth, pair.accessToken);
        if (error instanceof GitHubError) {
          return refuse('user-lookup-failed', {
            problem: error.problem.type,
            githubStatus: error.githubStatus,
            revoked,
          });
        }
        logger.error('owner connect failed after the exchange', { error, revoked });
        return backToSettings('failed');
      }
    })
    .get('/connection', async (c) => {
      const connection = await github.ownerConnection(c.env, c.get('logger'));
      const status = await connection.status();
      // The wrong-account copy (#89) needs the expected login before a first connect too; it is config, not a
      // secret, and a Worker without it already answers 503 on connect, so surfacing it here fails the same way.
      const appName = consoleAppNameFor(c.env.ENVIRONMENT);
      const body: GitHubConnectionDto =
        status.state === 'not-connected'
          ? { ...status, ownerLogin: github.ownerLogin(c.env), appName }
          : { ...status, appName };
      return c.json(body, 200, NO_STORE);
    })
    .delete('/connection', async (c) => {
      const connection = await github.ownerConnection(c.env, c.get('logger'));
      const outcome = await connection.disconnect();
      c.get('logger').info('owner disconnected', { ...outcome });
      if (outcome.kind === 'grant-may-be-live') {
        const body: GitHubDisconnectIncompleteDto = {
          revoked: false,
          action: 'revoke-on-github',
          reason: outcome.reason,
          manageUrl: GITHUB_AUTHORIZED_APPS_URL,
        };
        return c.json(body, 200, NO_STORE);
      }
      return c.body(null, 204, NO_STORE);
    });
}
