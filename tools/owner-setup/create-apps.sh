#!/usr/bin/env bash
# Owner setup: one GitHub App per environment via the App Manifest flow (issue #61, ADR 0003
# docs/decisions/0003-console-github-app.md, decisions 1, 3, 5, 6, 7). The OWNER runs this on their own
# machine, after `gh auth login`, `npx wrangler login` and `npm ci`, once each environment's Worker
# hostnames exist (after the first deploy of that environment, #25) — it is never run by an agent or in CI.
#
# What it does, per environment (`team-console-<env>`):
#   1. Serves a one-shot local page (create-apps-server.js) that auto-POSTs a prefilled App Manifest to
#      https://github.com/settings/apps/new with a random `state`. The owner reviews GitHub's confirmation
#      screen and clicks "Create GitHub App" — nothing here can skip that click.
#   2. Receives the redirect on 127.0.0.1, verifies `state`, exchanges the one-hour `code` for the app's
#      credentials (POST /app-manifests/{code}/conversions), and verifies the response is the exact app just
#      requested, owned by the same account this script already confirmed is the repository owner.
#   3. Records the new app's id and slug as GitHub Environment variables immediately — before touching any
#      secret — so a run that dies from here on leaves a breadcrumb pointing at the half-created app instead of
#      silent orphan on GitHub. Then pipes — never printing, never writing to disk, never on argv — the private
#      key (converted to PKCS#8), the webhook secret and a freshly generated TOKEN_ENCRYPTION_KEY into
#      `node_modules/.bin/wrangler secret put`, and the client secret **last** (see the comment at that call
#      site for why the order matters), plus sets CONSOLE_GITHUB_APP_CLIENT_ID and OWNER_GITHUB_LOGIN with
#      `gh variable set`.
#   4. Opens the app's Install page so the owner can install it (dev/stage: only geeera/team-console;
#      production: the owner's choice of product repositories, ADR 0003 decision 1).
#
# Safety properties (same bar as set-secrets.sh, PR #54):
#   - No secret value ever reaches argv, a file, or this terminal: every value flows from
#     create-apps-server.js's stdout (captured once, in memory) through `openssl`/`wrangler`/`gh` over
#     stdin/pipes. Only names, the app's settings URL and its install URL are printed.
#   - `node_modules/.bin/wrangler` only — never `npx wrangler`, which could silently fetch a different
#     version (see set-secrets.sh for the same reasoning).
#   - `OWNER_GITHUB_LOGIN` is the repository owner (`gh api repos/${REPO} --jq .owner.login`), not whichever
#     account `gh` happens to be authenticated as — the script refuses to continue if they differ
#     (SECURITY review round 1).
#   - The workers.dev subdomain is validated before it is ever put in a URL the owner is asked to glance at.
#   - Idempotent: an environment whose api Worker already has GITHUB_APP_CLIENT_SECRET set is skipped, unless
#     `--recreate` is passed, which walks through ADR 0003's rotation order and asks for a y/N confirmation
#     before creating a new app and replacing its secrets. A half-created app from an earlier, interrupted run
#     (detected via the CONSOLE_GITHUB_APP_SLUG breadcrumb) is reported with its settings URL before any retry.
#   - A failed credential-existence check (wrangler auth/network failure) stops the script; it is never
#     silently treated as "no app yet".
#
# What it does NOT do: create the D1 databases, Access applications, or Cloudflare secrets (CLOUDFLARE_*,
# VAPID_*) — see set-secrets.sh and .product-team/owner-checklist.md for those. It also does not deploy the
# Workers; the new GitHub Environment variables reach them on the next `deploy.yml` run.
set -euo pipefail

REPO="geeera/team-console"
API_WRANGLER="apps/api/wrangler.jsonc"
HOOKS_WRANGLER="apps/hooks/wrangler.jsonc"
WRANGLER="node_modules/.bin/wrangler"
SERVER_JS="tools/owner-setup/create-apps-server.js"
WRANGLER_SECRET_LIB="tools/owner-setup/lib/wrangler-secret.sh"
ALL_ENVIRONMENTS=(dev stage production)

ENV_FILTER=""
RECREATE=false
SUBDOMAIN="${CREATE_APPS_SUBDOMAIN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      shift
      ENV_FILTER="${1:-}"
      case "${ENV_FILTER}" in
        dev | stage | production) ;;
        *)
          echo "error: --env must be one of dev, stage, production (got '${ENV_FILTER}')" >&2
          exit 1
          ;;
      esac
      ;;
    --recreate) RECREATE=true ;;
    --subdomain)
      shift
      SUBDOMAIN="${1:-}"
      ;;
    *)
      echo "error: unknown argument '$1' (supported: --env <dev|stage|production>, --recreate, --subdomain <name>)" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -n "${ENV_FILTER}" ]; then
  ENVIRONMENTS=("${ENV_FILTER}")
else
  ENVIRONMENTS=("${ALL_ENVIRONMENTS[@]}")
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required — see the owner checklist (.product-team/owner-checklist.md)" >&2
    exit 1
  fi
}

require gh
require node
require openssl

if [ ! -f "${API_WRANGLER}" ] || [ ! -f "${HOOKS_WRANGLER}" ] || [ ! -f "${SERVER_JS}" ] || [ ! -f "${WRANGLER_SECRET_LIB}" ]; then
  echo "error: run this from the repository root (expected ${API_WRANGLER}, ${HOOKS_WRANGLER}, ${SERVER_JS}, ${WRANGLER_SECRET_LIB})" >&2
  exit 1
fi

if [ ! -x "${WRANGLER}" ]; then
  echo "error: ${WRANGLER} not found — run 'npm ci' first. This script never falls back to 'npx wrangler'," >&2
  echo "       which could silently download a different wrangler version onto this machine." >&2
  exit 1
fi

# shellcheck source=tools/owner-setup/lib/wrangler-secret.sh
# shellcheck source=tools/owner-setup/lib/wrangler-secret.sh
source "${WRANGLER_SECRET_LIB}"

if [ -z "${SUBDOMAIN}" ]; then
  read -rp "Cloudflare workers.dev subdomain (dashboard.cloudflare.com -> Workers & Pages, shown as <name>.workers.dev; not secret): " SUBDOMAIN
fi
if [ -z "${SUBDOMAIN}" ]; then
  echo "error: a workers.dev subdomain is required to build the app's callback and webhook URLs" >&2
  exit 1
fi
# SECURITY review round 1: an unvalidated subdomain lands straight in the manifest's callback/webhook URLs,
# which the owner is asked only to glance at on GitHub's confirmation screen.
if ! printf '%s' "${SUBDOMAIN}" | grep -qE '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  echo "error: '${SUBDOMAIN}' doesn't look like a workers.dev subdomain (expected lowercase letters, digits and internal hyphens only)" >&2
  exit 1
fi

json_field() {
  # Reads JSON on stdin, prints the named top-level field to stdout. Exit 2 = not JSON, 3 = field missing.
  node -e '
      let s = "";
      process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => {
        let obj;
        try { obj = JSON.parse(s); } catch (e) { process.exit(2); }
        const v = obj[process.argv[1]];
        if (v === undefined || v === null) { process.exit(3); }
        process.stdout.write(String(v));
      });
    ' "$1"
}

confirm_action() {
  local prompt="$1" reply
  read -rp "${prompt}" reply
  case "${reply}" in
    y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

# ADR 0003 decision 2: the OAuth callback only ever accepts the repository owner's own login, and the write-
# time owner check compares against `GET /repos/{repo}` -> `owner.login`, not whichever account happens to be
# logged into `gh`. SECURITY review round 1: if a secondary or machine `gh` session ran this script, that
# login would otherwise become "the owner" for connect-time purposes.
repo_owner_login=$(gh api "repos/${REPO}" --jq .owner.login)
current_user_login=$(gh api user --jq .login)
if [ -z "${repo_owner_login}" ] || [ -z "${current_user_login}" ]; then
  echo "error: could not determine the repository owner ('gh api repos/${REPO}') or the authenticated user ('gh api user')" >&2
  exit 1
fi
if [ "$(printf '%s' "${repo_owner_login}" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "${current_user_login}" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "error: 'gh' is authenticated as '${current_user_login}', but ${REPO}'s owner is '${repo_owner_login}'." >&2
  echo "       Run 'gh auth login' as '${repo_owner_login}' and try again — ADR 0003 requires this script to run as the repository owner." >&2
  exit 1
fi
owner_login="${repo_owner_login}"

for env in "${ENVIRONMENTS[@]}"; do
  app_name="team-console-${env}"
  echo "=== ${app_name} ==="

  if worker_secret_exists "${API_WRANGLER}" "${env}" GITHUB_APP_CLIENT_SECRET; then
    echo "${app_name} already appears fully configured (GITHUB_APP_CLIENT_SECRET is set on the api Worker for '${env}')."
    if [ "${RECREATE}" != true ]; then
      echo "skip: ${env} — pass --recreate to replace it."
      echo
      continue
    fi
    echo "ADR 0003's rotation order: in the console, Disconnect GitHub first (this revokes the owner grant"
    echo "while the old key can still decrypt it), THEN delete or revoke the old key in ${app_name}'s GitHub"
    echo "settings (Advanced -> Revoke all user tokens, then delete the private key)."
    if ! confirm_action "I have done that — continue and create a new ${app_name}, replacing its secrets? [y/N] "; then
      echo "skip: ${env}"
      echo
      continue
    fi
  elif half_slug=$(gh variable get CONSOLE_GITHUB_APP_SLUG --repo "${REPO}" --env "${env}" 2>/dev/null); then
    # A previous run recorded this breadcrumb right after GitHub created the app, before any secret was set —
    # see the write below. Its absence of a final GITHUB_APP_CLIENT_SECRET means that run never finished.
    echo "warning: an earlier run for '${env}' created a GitHub App (recorded slug '${half_slug}') but never finished configuring it."
    echo "  Settings: https://github.com/settings/apps/${half_slug}"
    echo "  Delete it there (Danger Zone -> Delete GitHub App) before continuing, to avoid an orphaned app with"
    echo "  a live, unrotatable private key sitting on GitHub."
    if ! confirm_action "Continue anyway and create a fresh ${app_name} for '${env}'? [y/N] "; then
      echo "skip: ${env} (half-created app not resolved)"
      echo
      continue
    fi
  fi

  callback_url="https://team-console-${env}.${SUBDOMAIN}.workers.dev/api/v1/github/callback"
  webhook_url="https://team-console-hooks-${env}.${SUBDOMAIN}.workers.dev/hooks/github"

  echo "Opening the App Manifest flow for ${app_name}."
  echo "Homepage: https://github.com/${REPO}"
  echo "Callback: ${callback_url}"
  echo "Webhook:  ${webhook_url}"
  echo "On GitHub's confirmation screen, review the prefilled app and click 'Create GitHub App'."
  echo

  conversion_json=$(
    CREATE_APPS_APP_NAME="${app_name}" \
      CREATE_APPS_HOMEPAGE_URL="https://github.com/${REPO}" \
      CREATE_APPS_CALLBACK_URL="${callback_url}" \
      CREATE_APPS_WEBHOOK_URL="${webhook_url}" \
      CREATE_APPS_EXPECTED_OWNER_LOGIN="${owner_login}" \
      CREATE_APPS_PORT="${CREATE_APPS_PORT:-0}" \
      CREATE_APPS_GITHUB_API_BASE="${CREATE_APPS_GITHUB_API_BASE:-https://api.github.com}" \
      CREATE_APPS_TEST_MODE="${CREATE_APPS_TEST_MODE:-}" \
      CREATE_APPS_TIMEOUT_MS="${CREATE_APPS_TIMEOUT_MS:-900000}" \
      node "${SERVER_JS}"
  )

  app_id=$(printf '%s' "${conversion_json}" | json_field id)
  client_id=$(printf '%s' "${conversion_json}" | json_field client_id)
  client_secret=$(printf '%s' "${conversion_json}" | json_field client_secret)
  webhook_secret=$(printf '%s' "${conversion_json}" | json_field webhook_secret)
  pem=$(printf '%s' "${conversion_json}" | json_field pem)
  slug=$(printf '%s' "${conversion_json}" | json_field slug)
  unset -v conversion_json

  print_recovery_hint() {
    echo
    echo "error: the run for '${env}' stopped after GitHub already created '${app_name}' (id ${app_id}, slug '${slug}')." >&2
    echo "  Settings: https://github.com/settings/apps/${slug}" >&2
    echo "  Delete it there (Danger Zone -> Delete GitHub App) before re-running, or pass --recreate once you have." >&2
  }
  trap print_recovery_hint ERR

  # Recorded first, before any secret is written, so a run that dies from here on leaves the breadcrumb above
  # (CONSOLE_GITHUB_APP_SLUG) for the next run — or the owner reading the checklist — instead of silently
  # retrying against a name GitHub already considers taken.
  printf '%s' "${app_id}" | gh variable set CONSOLE_GITHUB_APP_ID --repo "${REPO}" --env "${env}"
  printf '%s' "${slug}" | gh variable set CONSOLE_GITHUB_APP_SLUG --repo "${REPO}" --env "${env}"
  # Named CONSOLE_GITHUB_APP_ID / CONSOLE_GITHUB_APP_CLIENT_ID on the GitHub side, not GITHUB_APP_ID /
  # GITHUB_APP_CLIENT_ID: GitHub rejects a configuration variable whose name starts with the reserved GITHUB_
  # prefix (confirmed by actionlint, which flags `vars.GITHUB_APP_ID` as invalid — the same rule applies to
  # `gh variable set`). The Worker-side binding name is unaffected (deploy.yml's `--var GITHUB_APP_ID:...`
  # left-hand side is just wrangler's own binding name, not a GitHub configuration variable), so
  # apps/api/src/env.ts keeps reading GITHUB_APP_ID exactly as ADR 0003 (amended, decision 7) specifies.
  printf '%s' "${client_id}" | gh variable set CONSOLE_GITHUB_APP_CLIENT_ID --repo "${REPO}" --env "${env}"
  printf '%s' "${owner_login}" | gh variable set OWNER_GITHUB_LOGIN --repo "${REPO}" --env "${env}"
  echo "set: CONSOLE_GITHUB_APP_ID, CONSOLE_GITHUB_APP_SLUG, CONSOLE_GITHUB_APP_CLIENT_ID, OWNER_GITHUB_LOGIN -> GitHub environment '${env}' (non-secret variables)"
  unset -v app_id client_id

  printf '%s' "${pem}" | openssl pkcs8 -topk8 -nocrypt -inform PEM -outform PEM \
    | "${WRANGLER}" secret put GITHUB_APP_PRIVATE_KEY --env "${env}" --config "${API_WRANGLER}"
  echo "set: GITHUB_APP_PRIVATE_KEY -> api Worker, environment '${env}'"
  unset -v pem

  printf '%s' "${webhook_secret}" | "${WRANGLER}" secret put WEBHOOK_SECRET --env "${env}" --config "${HOOKS_WRANGLER}"
  echo "set: WEBHOOK_SECRET -> hooks Worker, environment '${env}'"
  unset -v webhook_secret

  token_encryption_key=$(openssl rand -base64 32)
  printf '%s' "${token_encryption_key}" | "${WRANGLER}" secret put TOKEN_ENCRYPTION_KEY --env "${env}" --config "${API_WRANGLER}"
  echo "set: TOKEN_ENCRYPTION_KEY -> api Worker, environment '${env}'"
  unset -v token_encryption_key

  # Written last on purpose (SECURITY review round 1): this is exactly the name the idempotency check at the
  # top of this loop looks for, so "the app is fully configured" only becomes true once everything above
  # already succeeded. A run that fails any earlier step leaves this unset, which the half-created-app check
  # above catches on the next run via CONSOLE_GITHUB_APP_SLUG.
  printf '%s' "${client_secret}" | "${WRANGLER}" secret put GITHUB_APP_CLIENT_SECRET --env "${env}" --config "${API_WRANGLER}"
  echo "set: GITHUB_APP_CLIENT_SECRET -> api Worker, environment '${env}'"
  unset -v client_secret

  trap - ERR

  echo
  echo "App settings: https://github.com/settings/apps/${slug}"
  install_url="https://github.com/apps/${slug}/installations/new"
  echo "Install URL:  ${install_url}"
  echo "Install on: $( [ "${env}" = production ] && echo 'the product repositories you manage' || echo "only ${REPO} (sandbox)" )."
  # CREATE_APPS_NO_OPEN=1 is test-only (see create-apps.stub-test.sh) — never documented to the owner.
  if [ "${CREATE_APPS_NO_OPEN:-}" != "1" ]; then
    opener="open"
    case "$(uname -s 2>/dev/null || true)" in
      Linux) opener="xdg-open" ;;
    esac
    "${opener}" "${install_url}" >/dev/null 2>&1 || echo "(could not auto-open a browser — open the Install URL above manually)"
  fi
  unset -v slug

  echo
  echo "REMINDER: in ${app_name}'s settings (General tab), confirm 'Expire user authorization tokens' is ON"
  echo "and Device Flow is OFF (GitHub defaults for new apps — verify, do not assume)."
  echo
done

echo "Done. Redeploy the affected environment(s) so the new GitHub Environment variables reach the Worker."
