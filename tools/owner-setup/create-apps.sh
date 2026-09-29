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
#      credentials (POST /app-manifests/{code}/conversions).
#   3. Pipes — never printing, never writing to disk, never on argv — the private key (converted to PKCS#8),
#      the client secret and the webhook secret straight into `node_modules/.bin/wrangler secret put`, and a
#      freshly generated TOKEN_ENCRYPTION_KEY into the api Worker; sets the three non-secret GitHub
#      Environment variables (GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, OWNER_GITHUB_LOGIN) with `gh variable set`.
#   4. Opens the app's Install page so the owner can install it (dev/stage: only geeera/team-console;
#      production: the owner's choice of product repositories, ADR 0003 decision 1).
#
# Safety properties (same bar as set-secrets.sh, PR #54):
#   - No secret value ever reaches argv, a file, or this terminal: every value flows from
#     create-apps-server.js's stdout (captured once, in memory) through `openssl`/`wrangler`/`gh` over
#     stdin/pipes. Only names, the app's settings URL and its install URL are printed.
#   - `node_modules/.bin/wrangler` only — never `npx wrangler`, which could silently fetch a different
#     version (see set-secrets.sh for the same reasoning).
#   - Idempotent: an environment whose api Worker already has GITHUB_APP_CLIENT_SECRET set is skipped, unless
#     `--recreate` is passed, which asks for a y/N confirmation before creating a new app and replacing it.
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

if [ ! -f "${API_WRANGLER}" ] || [ ! -f "${HOOKS_WRANGLER}" ] || [ ! -f "${SERVER_JS}" ]; then
  echo "error: run this from the repository root (expected ${API_WRANGLER}, ${HOOKS_WRANGLER}, ${SERVER_JS})" >&2
  exit 1
fi

if [ ! -x "${WRANGLER}" ]; then
  echo "error: ${WRANGLER} not found — run 'npm ci' first. This script never falls back to 'npx wrangler'," >&2
  echo "       which could silently download a different wrangler version onto this machine." >&2
  exit 1
fi

if [ -z "${SUBDOMAIN}" ]; then
  read -rp "Cloudflare workers.dev subdomain (dashboard.cloudflare.com -> Workers & Pages, shown as <name>.workers.dev; not secret): " SUBDOMAIN
fi
if [ -z "${SUBDOMAIN}" ]; then
  echo "error: a workers.dev subdomain is required to build the app's callback and webhook URLs" >&2
  exit 1
fi

# --- does this environment's app already exist? Same "never silently treat a listing failure as 'not set'" --
# --- rule as set-secrets.sh's worker_secret_exists (PR #54 QA round 4); duplicated rather than shared with --
# --- set-secrets.sh on purpose: that script already carries four rounds of QA history and this issue does --
# --- not touch it. -------------------------------------------------------------------------------------------
worker_secret_exists() {
  local config="$1" env="$2" name="$3" listing listing_err
  listing_err=$(mktemp)
  if listing=$("${WRANGLER}" secret list --env "${env}" --config "${config}" 2>"${listing_err}"); then
    rm -f "${listing_err}"
  else
    local stderr_text
    stderr_text=$(cat "${listing_err}")
    rm -f "${listing_err}"
    if printf '%s' "${stderr_text}" | grep -q 'not found\.' \
      && printf '%s' "${stderr_text}" | grep -q 'wrangler deploy'; then
      return 1
    fi
    echo "error: 'wrangler secret list --env ${env} --config ${config}' failed — cannot tell whether ${name} is already set" >&2
    echo "${stderr_text}" >&2
    exit 1
  fi

  local rc
  set +e
  printf '%s' "${listing}" | node -e '
      let s = "";
      process.stdin.on("data", (d) => { s += d; });
      process.stdin.on("end", () => {
        let list;
        try { list = JSON.parse(s); } catch (e) { process.exit(2); }
        process.exit(list.some((x) => x.name === process.argv[1]) ? 0 : 1);
      });
    ' "${name}"
  rc=$?
  set -e
  if [ "${rc}" -eq 2 ]; then
    echo "error: could not parse 'wrangler secret list --env ${env} --config ${config}' output as JSON" >&2
    exit 1
  fi
  return "${rc}"
}

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

confirm_recreate() {
  local label="$1" reply
  if [ "${RECREATE}" != true ]; then
    return 1
  fi
  read -rp "Really create a new ${label} and replace its secrets? [y/N] " reply
  case "${reply}" in
    y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

owner_login=$(gh api user --jq .login)
if [ -z "${owner_login}" ]; then
  echo "error: 'gh api user' returned no login — is 'gh auth login' done on the owner's account?" >&2
  exit 1
fi

for env in "${ENVIRONMENTS[@]}"; do
  app_name="team-console-${env}"
  echo "=== ${app_name} ==="

  if worker_secret_exists "${API_WRANGLER}" "${env}" GITHUB_APP_CLIENT_SECRET; then
    if ! confirm_recreate "${app_name} app (GITHUB_APP_CLIENT_SECRET is already set on the api Worker for '${env}')"; then
      echo "skip: ${app_name} appears to already exist — use --recreate to create a new app and replace its secrets"
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
      CREATE_APPS_PORT="${CREATE_APPS_PORT:-0}" \
      CREATE_APPS_GITHUB_API_BASE="${CREATE_APPS_GITHUB_API_BASE:-https://api.github.com}" \
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

  printf '%s' "${pem}" | openssl pkcs8 -topk8 -nocrypt -inform PEM -outform PEM \
    | "${WRANGLER}" secret put GITHUB_APP_PRIVATE_KEY --env "${env}" --config "${API_WRANGLER}"
  echo "set: GITHUB_APP_PRIVATE_KEY -> api Worker, environment '${env}'"
  unset -v pem

  printf '%s' "${client_secret}" | "${WRANGLER}" secret put GITHUB_APP_CLIENT_SECRET --env "${env}" --config "${API_WRANGLER}"
  echo "set: GITHUB_APP_CLIENT_SECRET -> api Worker, environment '${env}'"
  unset -v client_secret

  printf '%s' "${webhook_secret}" | "${WRANGLER}" secret put WEBHOOK_SECRET --env "${env}" --config "${HOOKS_WRANGLER}"
  echo "set: WEBHOOK_SECRET -> hooks Worker, environment '${env}'"
  unset -v webhook_secret

  token_encryption_key=$(openssl rand -base64 32)
  printf '%s' "${token_encryption_key}" | "${WRANGLER}" secret put TOKEN_ENCRYPTION_KEY --env "${env}" --config "${API_WRANGLER}"
  echo "set: TOKEN_ENCRYPTION_KEY -> api Worker, environment '${env}'"
  unset -v token_encryption_key

  # Named CONSOLE_GITHUB_APP_ID / CONSOLE_GITHUB_APP_CLIENT_ID on the GitHub side, not GITHUB_APP_ID /
  # GITHUB_APP_CLIENT_ID as ADR 0003 decision 7 originally wrote them: GitHub rejects a configuration
  # variable whose name starts with the reserved GITHUB_ prefix (confirmed by actionlint, which flags
  # `vars.GITHUB_APP_ID` as invalid — the same rule applies to `gh variable set`). The Worker-side binding
  # name is unaffected (deploy.yml's `--var GITHUB_APP_ID:...` left-hand side is just wrangler's own binding
  # name, not a GitHub configuration variable), so apps/api/src/env.ts keeps reading GITHUB_APP_ID exactly as
  # the ADR specifies — only the GitHub Environment variable that feeds it is renamed. Flagged for the ADR to
  # be corrected; see the PR description.
  printf '%s' "${app_id}" | gh variable set CONSOLE_GITHUB_APP_ID --repo "${REPO}" --env "${env}"
  printf '%s' "${client_id}" | gh variable set CONSOLE_GITHUB_APP_CLIENT_ID --repo "${REPO}" --env "${env}"
  printf '%s' "${owner_login}" | gh variable set OWNER_GITHUB_LOGIN --repo "${REPO}" --env "${env}"
  echo "set: CONSOLE_GITHUB_APP_ID, CONSOLE_GITHUB_APP_CLIENT_ID, OWNER_GITHUB_LOGIN -> GitHub environment '${env}' (non-secret variables)"
  unset -v app_id client_id

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
