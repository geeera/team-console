#!/usr/bin/env node
// Small helper for create-apps.sh (#61, ADR 0003): serves the one-shot local page that auto-POSTs a GitHub
// App Manifest to https://github.com/settings/apps/new, receives the redirect back on 127.0.0.1, and
// exchanges the one-hour `code` for the app's credentials via POST /app-manifests/{code}/conversions.
//
// No npm dependency — only Node's built-in http/https/crypto. Contract with the caller (create-apps.sh):
//   - every status/progress message goes to stderr;
//   - exactly one line of JSON is written to stdout as the very last thing this process does, and nothing else
//     ever touches stdout — but only in the two cases below; on a timeout, a network error, or a missing code,
//     nothing is written and the caller has only the pre-flight breadcrumb it already recorded (SECURITY round
//     2, #67): there is no conversion response to report:
//       - success: `{...conversion, "ok": true}` (the GitHub conversion response, secrets included; `ok` is
//         spread last so GitHub's response body can never override it);
//       - the exchange succeeded but the response failed verification (wrong name/owner): `{"ok": false,
//         "name": ..., "slug": ..., "owner": {"login": ..., "type": ...}}` — an explicit allowlist, not the raw
//         GitHub owner object, enough for the caller to point at the app that *was* created instead of silently
//         orphaning it, without ever including a secret (SECURITY round 2 note A of the old contract: a
//         mismatched app still holds a private key and client secret on GitHub).
//   - the process exits 0 on success, non-zero on any failure (GitHub error, validation failure, timeout).
// The caller captures stdout into a shell variable and never echoes it — this script never writes the
// response to disk and never logs it itself.
//
// Hardening (SECURITY review round 1 on #61, PR #65):
//   - Every request must carry `Host: 127.0.0.1:<port>` exactly, on every route — otherwise it is rejected
//     before anything (including the page that carries `state`) is served. This is the fix for a DNS-rebinding
//     page (or another local user/process finding the ephemeral port) reading `state` or replaying `/callback`.
//   - `state` is compared with `crypto.timingSafeEqual`, and the callback is marked consumed synchronously on
//     the first hit with a matching state — before the (async) code exchange — so a second, concurrent hit
//     with the same state cannot start a second exchange.
//   - A request with a missing or wrong `state` no longer aborts the run: it is logged and answered with an
//     error page, and the server keeps waiting for the real redirect (a bare/malformed hit otherwise made this
//     an easy local denial of service).
//   - The conversion response is verified before anything is trusted: `name` must equal the exact app name
//     requested, and `owner.login` (case-insensitively) plus `owner.type === 'User'` must match the repository
//     owner create-apps.sh resolved independently. Anything else aborts without emitting the response.
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const APP_NAME = requireEnv('CREATE_APPS_APP_NAME');
const HOMEPAGE_URL = requireEnv('CREATE_APPS_HOMEPAGE_URL');
const CALLBACK_URL = requireEnv('CREATE_APPS_CALLBACK_URL');
const WEBHOOK_URL = requireEnv('CREATE_APPS_WEBHOOK_URL');
const EXPECTED_OWNER_LOGIN = requireEnv('CREATE_APPS_EXPECTED_OWNER_LOGIN');
const REQUESTED_PORT = Number(env('CREATE_APPS_PORT', '0'));
const TIMEOUT_MS = Number(env('CREATE_APPS_TIMEOUT_MS', String(15 * 60 * 1000)));

// Test-only, and only honoured when CREATE_APPS_TEST_MODE=1 *and* the override is a http://127.0.0.1 origin —
// SECURITY review round 1: a stray export of CREATE_APPS_GITHUB_API_BASE in the owner's own shell (a dotfile,
// direnv, a bad copy-paste) must never be able to redirect the one-hour manifest `code` — and everything it
// unlocks — to a third party. Real runs always talk to https://api.github.com. Never documented to the owner.
function resolveGithubApiBase() {
  const override = process.env.CREATE_APPS_GITHUB_API_BASE;
  const DEFAULT_BASE = 'https://api.github.com';
  if (!override) return DEFAULT_BASE;

  if (env('CREATE_APPS_TEST_MODE', '') !== '1') {
    console.error(
      'warning: CREATE_APPS_GITHUB_API_BASE is set but ignored (CREATE_APPS_TEST_MODE is not "1"); using ' +
        DEFAULT_BASE,
    );
    return DEFAULT_BASE;
  }

  let parsed;
  try {
    parsed = new URL(override);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.hostname !== '127.0.0.1') {
    console.error(
      `warning: CREATE_APPS_GITHUB_API_BASE ('${override}') is not a http://127.0.0.1 origin; ignoring, using ${DEFAULT_BASE}`,
    );
    return DEFAULT_BASE;
  }
  return override;
}

const GITHUB_API_BASE = resolveGithubApiBase();

const state = crypto.randomBytes(24).toString('hex');
let consumed = false;

const manifest = {
  name: APP_NAME,
  url: HOMEPAGE_URL,
  hook_attributes: { url: WEBHOOK_URL },
  callback_urls: [CALLBACK_URL],
  public: false,
  // "Request user authorization (OAuth) during installation" off — ADR 0003 decision 3.
  request_oauth_on_install: false,
  default_permissions: {
    metadata: 'read',
    issues: 'write',
    pull_requests: 'read',
    contents: 'read',
    actions: 'read',
  },
  default_events: ['issues', 'issue_comment', 'pull_request', 'workflow_run', 'release', 'push'],
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function manifestPageHtml(redirectUrl) {
  const target = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const manifestWithRedirect = { ...manifest, redirect_url: redirectUrl };
  const manifestJson = JSON.stringify(manifestWithRedirect);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create ${escapeHtml(APP_NAME)}</title></head>
<body>
<p>Redirecting to GitHub to create <strong>${escapeHtml(APP_NAME)}</strong>&hellip;</p>
<form id="manifest-form" action="${escapeHtml(target)}" method="post">
  <input type="hidden" name="manifest" value='${escapeHtml(manifestJson)}'>
</form>
<script>document.getElementById('manifest-form').submit();</script>
</body></html>`;
}

function donePageHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><p>${escapeHtml(message)}</p>
<p>You can close this tab and return to the terminal.</p></body></html>`;
}

// Constant-time, but only meaningful once lengths match — `state`'s length is fixed and public (48 hex
// chars), so comparing lengths first leaks nothing new; `timingSafeEqual` throws on a length mismatch.
function stateMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(state, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function convert(code) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/app-manifests/${encodeURIComponent(code)}/conversions`, GITHUB_API_BASE);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'team-console-create-apps-script',
          'Content-Length': 0,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            reject(new Error(`GitHub conversion endpoint answered HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`could not parse the conversion response as JSON: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Refuses to trust the conversion response just because the one-hour `code` happened to arrive: `name` must
// be exactly what we asked for, and the app must be owned by the same account create-apps.sh already verified
// is this repository's owner — closes the path where a code for an attacker-owned app, replayed onto this
// listener, would otherwise get installed as if it were the owner's.
function conversionIsTrusted(conversion) {
  if (!conversion || conversion.name !== APP_NAME) return false;
  const owner = conversion.owner;
  if (!owner || typeof owner.login !== 'string') return false;
  if (owner.login.toLowerCase() !== EXPECTED_OWNER_LOGIN.toLowerCase()) return false;
  return owner.type === 'User';
}

let finished = false;
let timeoutHandle;
let listeningPort;

function finish(server, exitCode, stdoutLine) {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  server.close(() => {
    if (stdoutLine !== undefined) {
      process.stdout.write(stdoutLine + '\n');
    }
    process.exit(exitCode);
  });
}

function isLoopbackHost(req) {
  return req.headers.host === `127.0.0.1:${listeningPort}`;
}

const server = http.createServer((req, res) => {
  // Applies to every route, including `/`: a DNS-rebinding page (attacker-controlled name that resolves to
  // 127.0.0.1) or another process on a shared machine must not be able to read `state` off the manifest page
  // or hit `/callback` under a different Host — confirmed reproducible before this check (SECURITY round 1).
  if (!isLoopbackHost(req)) {
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    res.end('misdirected request');
    console.error(`warning: rejected a request with Host '${req.headers.host}', expected '127.0.0.1:${listeningPort}'`);
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && req.method === 'GET') {
    const redirectUrl = `http://127.0.0.1:${listeningPort}/callback`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(manifestPageHtml(redirectUrl));
    return;
  }

  if (url.pathname === '/callback' && req.method === 'GET') {
    const returnedState = url.searchParams.get('state');

    // A missing or wrong state no longer aborts the run — only logged and answered with an error page. Before
    // the Host check above this was a one-request local denial of service (any bare `GET /callback` killed the
    // 15-minute window); now that only a same-origin request can reach here at all, treating it as noise
    // (a stale tab, a duplicate load) and continuing to wait for the real redirect is the safer default.
    if (!stateMatches(returnedState)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePageHtml('not a valid callback request.'));
      console.error('warning: ignored a /callback request with a missing or incorrect state');
      return;
    }

    // Single-use, marked synchronously before the (async) code exchange starts: a second request that somehow
    // carries the correct state (a duplicate delivery, a replay while the first exchange is still in flight)
    // must not be able to trigger a second conversion.
    if (consumed) {
      res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePageHtml('this callback was already used.'));
      console.error('warning: ignored a second /callback request with a valid state — already consumed');
      return;
    }
    consumed = true;

    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePageHtml('no code in the redirect.'));
      console.error('error: the redirect back from GitHub carried a valid state but no code');
      finish(server, 1);
      return;
    }

    convert(code)
      .then((conversion) => {
        if (!conversionIsTrusted(conversion)) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(donePageHtml('the created app does not match what was requested — see the terminal.'));
          console.error(
            `error: refusing the conversion response — expected name '${APP_NAME}' owned by '${EXPECTED_OWNER_LOGIN}' ` +
              `(type User), got name '${conversion && conversion.name}' owned by ` +
              `'${conversion && conversion.owner && conversion.owner.login}' (type ${conversion && conversion.owner && conversion.owner.type})`,
          );
          // Reports name/slug/owner only — never pem/client_secret/webhook_secret — so create-apps.sh can
          // still point the owner at whatever GitHub actually created instead of leaving it untracked. `owner`
          // is an explicit {login, type} allowlist, not the raw GitHub object, so an unexpected extra field in
          // GitHub's response can never leak into the caller's output (SECURITY review, #67).
          finish(
            server,
            1,
            JSON.stringify({
              ok: false,
              name: conversion && conversion.name,
              slug: conversion && conversion.slug,
              owner: {
                login: conversion && conversion.owner && conversion.owner.login,
                type: conversion && conversion.owner && conversion.owner.type,
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePageHtml(`${APP_NAME} created.`));
        console.error(`ok: exchanged the manifest code for ${APP_NAME}'s credentials`);
        // `ok: true` is spread last so a (hypothetical) `ok` field in GitHub's own response can never override
        // the literal success marker (SECURITY review, #67).
        finish(server, 0, JSON.stringify({ ...conversion, ok: true }));
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePageHtml('the conversion request to GitHub failed — see the terminal.'));
        console.error(`error: ${err.message}`);
        finish(server, 1);
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('error', (err) => {
  console.error(`error: local server failed: ${err.message}`);
  process.exit(1);
});

server.listen(REQUESTED_PORT, '127.0.0.1', () => {
  listeningPort = server.address().port;
  console.error(`Open this URL in your browser (it auto-submits the manifest to GitHub):`);
  console.error(`  http://127.0.0.1:${listeningPort}/`);
  console.error('Waiting for the redirect back from GitHub…');

  timeoutHandle = setTimeout(() => {
    console.error('error: timed out waiting for the redirect back from GitHub');
    finish(server, 1);
  }, TIMEOUT_MS);

  // CREATE_APPS_NO_OPEN=1 is test-only: the stub test never wants a real browser touched, and a launched
  // browser hitting this same page a second time raced the `listeningPort` capture above (caught while
  // developing this test).
  if (env('CREATE_APPS_NO_OPEN', '') !== '1') {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      require('node:child_process')
        .spawn(opener, [`http://127.0.0.1:${listeningPort}/`], { stdio: 'ignore', detached: true })
        .unref();
    } catch {
      // best-effort only — the URL printed above is the fallback.
    }
  }
});
