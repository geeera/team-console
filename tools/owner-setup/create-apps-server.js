#!/usr/bin/env node
// Small helper for create-apps.sh (#61, ADR 0003): serves the one-shot local page that auto-POSTs a GitHub
// App Manifest to https://github.com/settings/apps/new, receives the redirect back on 127.0.0.1, and
// exchanges the one-hour `code` for the app's credentials via POST /app-manifests/{code}/conversions.
//
// No npm dependency — only Node's built-in http/https/crypto. Contract with the caller (create-apps.sh):
//   - every status/progress message goes to stderr;
//   - on success, exactly one line of JSON (the GitHub conversion response, secrets included) is written to
//     stdout as the very last thing this process does, and nothing else ever touches stdout;
//   - the process exits 0 on success, non-zero on any failure (state mismatch, GitHub error, timeout).
// The caller captures stdout into a shell variable and never echoes it — this script never writes the
// response to disk and never logs it itself.
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
// Test-only override: the real script always talks to https://api.github.com. Never documented to the owner.
const GITHUB_API_BASE = env('CREATE_APPS_GITHUB_API_BASE', 'https://api.github.com');
const REQUESTED_PORT = Number(env('CREATE_APPS_PORT', '0'));
const TIMEOUT_MS = Number(env('CREATE_APPS_TIMEOUT_MS', String(15 * 60 * 1000)));

const state = crypto.randomBytes(24).toString('hex');

const manifest = {
  name: APP_NAME,
  url: HOMEPAGE_URL,
  hook_attributes: { url: WEBHOOK_URL },
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

function donePageHtml(ok, message) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><p>${escapeHtml(message)}</p>
<p>You can close this tab and return to the terminal.</p></body></html>`;
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && req.method === 'GET') {
    const redirectUrl = `http://127.0.0.1:${listeningPort}/callback`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(manifestPageHtml(redirectUrl));
    return;
  }

  if (url.pathname === '/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');

    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePageHtml(false, 'state mismatch — refusing to continue.'));
      console.error('error: the redirect back from GitHub carried an unexpected state — refusing to exchange the code');
      finish(server, 1);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePageHtml(false, 'no code in the redirect.'));
      console.error('error: the redirect back from GitHub carried no code');
      finish(server, 1);
      return;
    }

    convert(code)
      .then((conversion) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePageHtml(true, `${APP_NAME} created.`));
        console.error(`ok: exchanged the manifest code for ${APP_NAME}'s credentials`);
        finish(server, 0, JSON.stringify(conversion));
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePageHtml(false, 'the conversion request to GitHub failed — see the terminal.'));
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
