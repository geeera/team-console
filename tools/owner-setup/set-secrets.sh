#!/usr/bin/env bash
# One-time (and idempotent) local setup for the Cloudflare + GitHub secrets in the owner checklist (issue
# #7, ADR 0001 Consequences). The OWNER runs this on their own machine, after `gh auth login`, `npx wrangler
# login` and `npm ci` — it is never run by an agent or in CI.
#
# Safety properties:
#   - No secret value ever reaches argv (visible to any other process on the machine via `ps`/`/proc`) or a
#     file: every value goes into `gh secret set` / `wrangler secret put` over stdin. `node` is only ever
#     given secret *names* (to check what is already set) as an argument, or generates a VAPID key pair with
#     no input at all (see vapid-keygen.js) — never a secret value as an argument. Only secret names are
#     printed to this terminal. `worker_secret_exists` does use a temp file, but only to hold `wrangler`'s own
#     plain-text error output when a listing fails — never a secret value — and removes it immediately.
#   - No unpinned code runs with these credentials next to it: the VAPID key pair is generated with Node's
#     built-in `crypto` (`vapid-keygen.js`, no npm package involved — see there for why OpenSSL's `-text`
#     output was dropped, PR #54 QA round 3), and the Cloudflare calls use the exact `wrangler` already
#     installed by `npm ci` (`node_modules/.bin/wrangler`) — never `npx wrangler`, which could silently fetch
#     a different version.
#   - True idempotency: a secret that already exists (by name) is left alone and reported as skipped, unless
#     `--rotate` is passed, which asks for a y/N confirmation before replacing it. The VAPID pair is asked
#     about once per environment and always written to both Workers together or not at all — a previous run
#     that set it on only one Worker is reported as a partial state and only fixed with `--rotate`.
#   - A failed `gh secret list` / `wrangler secret list` (network, auth, ...) stops the script with an error;
#     it is never treated as "the secret is not set".
#
# What it does NOT do: create the D1 databases, the Access applications, the Pages project, or the console
# GitHub App (ADR 0003, #61) — those need a browser and stay click-by-click steps in
# .product-team/owner-checklist.md. It also does not set WEBHOOK_SECRET: that value must equal the console
# GitHub App's own webhook secret, so it is set by #61's app-setup script, not here.
set -euo pipefail

REPO="geeera/team-console"
ENVIRONMENTS=(dev stage production)
API_WRANGLER="apps/api/wrangler.jsonc"
HOOKS_WRANGLER="apps/hooks/wrangler.jsonc"
WRANGLER="node_modules/.bin/wrangler"
VAPID_KEYGEN="tools/owner-setup/vapid-keygen.js"
WRANGLER_SECRET_LIB="tools/owner-setup/lib/wrangler-secret.sh"

ROTATE=false
for arg in "$@"; do
  case "${arg}" in
    --rotate) ROTATE=true ;;
    *)
      echo "error: unknown argument '${arg}' (only --rotate is supported)" >&2
      exit 1
      ;;
  esac
done

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required — see the owner checklist (.product-team/owner-checklist.md)" >&2
    exit 1
  fi
}

require gh
require node

if [ ! -f "${API_WRANGLER}" ] || [ ! -f "${HOOKS_WRANGLER}" ] || [ ! -f "${VAPID_KEYGEN}" ] || [ ! -f "${WRANGLER_SECRET_LIB}" ]; then
  echo "error: run this from the repository root (expected ${API_WRANGLER}, ${HOOKS_WRANGLER}, ${VAPID_KEYGEN}, ${WRANGLER_SECRET_LIB})" >&2
  exit 1
fi

if [ ! -x "${WRANGLER}" ]; then
  echo "error: ${WRANGLER} not found — run 'npm ci' first. This script never falls back to 'npx wrangler'," >&2
  echo "       which could silently download a different wrangler version onto this machine." >&2
  exit 1
fi

# shellcheck source=tools/owner-setup/lib/wrangler-secret.sh
source "${WRANGLER_SECRET_LIB}"

# --- helpers: does this secret already exist? A failed listing is an error, never "not set". ----------------

gh_secret_exists() {
  local env="$1" name="$2" names
  if ! names=$(gh secret list --repo "${REPO}" --env "${env}" --json name -q '.[].name'); then
    echo "error: 'gh secret list --env ${env}' failed — cannot tell whether ${name} is already set" >&2
    exit 1
  fi
  printf '%s\n' "${names}" | grep -qx "${name}"
}

# worker_secret_exists is defined in tools/owner-setup/lib/wrangler-secret.sh, sourced above (shared with
# create-apps.sh, #61 REVIEW round 1) — same signature and behavior as before the extraction.

confirm_rotate() {
  local label="$1" reply
  if [ "${ROTATE}" != true ]; then
    return 1
  fi
  read -rp "Really rotate ${label}? [y/N] " reply
  case "${reply}" in
    y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

set_gh_secret() {
  local env="$1" name="$2" value="$3"
  if gh_secret_exists "${env}" "${name}"; then
    if ! confirm_rotate "${name} on GitHub environment '${env}'"; then
      echo "skip: ${name} already set on GitHub environment '${env}' (use --rotate to replace)"
      return 0
    fi
  fi
  printf '%s' "${value}" | gh secret set "${name}" --repo "${REPO}" --env "${env}"
  echo "set: ${name} -> GitHub environment '${env}'"
}

put_worker_secret() {
  local config="$1" env="$2" name="$3" value="$4" worker_label="$5"
  printf '%s' "${value}" | "${WRANGLER}" secret put "${name}" --env "${env}" --config "${config}"
  echo "set: ${name} -> ${worker_label} Worker, environment '${env}'"
}

# --------------------------------------------------------------------------------------------------------

echo "This sets, for dev/stage/production (skipping anything already set — pass --rotate to replace):"
echo "  - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub Environment secrets"
echo "  - a VAPID key pair: the private half as a Worker secret on 'api' and 'hooks', the public half printed"
echo "    below for you to paste into the environment's non-secret GitHub variable VAPID_PUBLIC_KEY"
echo
echo "It does NOT set WEBHOOK_SECRET — that comes from the console GitHub App (#61) so it can match the"
echo "app's own webhook secret; use that setup script instead."
echo
echo "Nothing you type or that is generated here is echoed, written to a file, or logged."
echo

cf_api_token=""
cf_account_id=""
trap 'unset -v cf_api_token cf_account_id' EXIT

read -rsp "Cloudflare API token (input hidden): " cf_api_token
echo
read -rsp "Cloudflare account id (input hidden): " cf_account_id
echo
echo

for env in "${ENVIRONMENTS[@]}"; do
  set_gh_secret "${env}" CLOUDFLARE_API_TOKEN "${cf_api_token}"
  set_gh_secret "${env}" CLOUDFLARE_ACCOUNT_ID "${cf_account_id}"
done

unset -v cf_api_token cf_account_id

for env in "${ENVIRONMENTS[@]}"; do
  api_has=false
  hooks_has=false
  worker_secret_exists "${API_WRANGLER}" "${env}" VAPID_PRIVATE_KEY && api_has=true
  worker_secret_exists "${HOOKS_WRANGLER}" "${env}" VAPID_PRIVATE_KEY && hooks_has=true

  if [ "${api_has}" = true ] && [ "${hooks_has}" = true ]; then
    if ! confirm_rotate "VAPID_PRIVATE_KEY for '${env}' (already set on both api and hooks)"; then
      echo "skip: VAPID_PRIVATE_KEY already set on both Workers for '${env}' (use --rotate to replace — this breaks every existing push subscription)"
      continue
    fi
  elif [ "${api_has}" = true ] || [ "${hooks_has}" = true ]; then
    echo "warning: VAPID_PRIVATE_KEY for '${env}' is set on only one Worker (api=${api_has}, hooks=${hooks_has}) — a previous run likely failed partway"
    if ! confirm_rotate "VAPID_PRIVATE_KEY for '${env}' (fix the partial state by writing a fresh pair to both)"; then
      echo "skip: leaving the partial VAPID_PRIVATE_KEY state for '${env}' — re-run with --rotate to fix it"
      continue
    fi
  fi
  # else: neither Worker has it yet — generate and write both below, nothing to confirm.

  vapid_output=$(node "${VAPID_KEYGEN}")
  vapid_private=$(printf '%s\n' "${vapid_output}" | sed -n '1p')
  vapid_public=$(printf '%s\n' "${vapid_output}" | sed -n '2p')
  unset -v vapid_output

  put_worker_secret "${API_WRANGLER}" "${env}" VAPID_PRIVATE_KEY "${vapid_private}" api
  put_worker_secret "${HOOKS_WRANGLER}" "${env}" VAPID_PRIVATE_KEY "${vapid_private}" hooks
  unset -v vapid_private

  echo "VAPID public key for '${env}' (NOT a secret) — paste it into GitHub: Settings -> Environments ->"
  echo "  ${env} -> Variables -> VAPID_PUBLIC_KEY:"
  echo "  ${vapid_public}"
  unset -v vapid_public
  echo
done

echo "Done. No secret value touched disk. Copy any freshly generated VAPID public keys now if you have not —"
echo "they only exist in this terminal's scrollback."
