#!/usr/bin/env bash
# One-time local setup for the Cloudflare + GitHub secrets in the owner checklist (issue #7, ADR 0001
# Consequences). The OWNER runs this on their own machine, after `gh auth login` and `npx wrangler login` —
# it is never run by an agent or in CI. It never puts a secret value in argv (visible to any other process
# via `ps`), a file, or a log: every value goes into `gh secret set` / `wrangler secret put` over stdin, and
# the script prints only the *names* of what it set. Idempotent: re-running overwrites the same names with
# freshly typed/generated values, so nothing is left half-set.
#
# What it does NOT do: create the D1 databases, the Access applications, the Pages project, or the GitHub
# token(s) — those need a browser and are still click-by-click steps in .product-team/owner-checklist.md.
set -euo pipefail

REPO="geeera/team-console"
ENVIRONMENTS=(dev stage production)
API_WRANGLER="apps/api/wrangler.jsonc"
HOOKS_WRANGLER="apps/hooks/wrangler.jsonc"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' is required — see the owner checklist (.product-team/owner-checklist.md)" >&2
    exit 1
  fi
}

require gh
require npx
require openssl
require node

if [ ! -f "${API_WRANGLER}" ] || [ ! -f "${HOOKS_WRANGLER}" ]; then
  echo "error: run this from the repository root (expected ${API_WRANGLER} and ${HOOKS_WRANGLER})" >&2
  exit 1
fi

echo "This sets, for dev/stage/production:"
echo "  - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub Environment secrets"
echo "  - a fresh WEBHOOK_SECRET as a Cloudflare Worker secret on 'hooks'"
echo "  - a fresh VAPID key pair: the private half as a Worker secret on 'api' and 'hooks', the public half"
echo "    printed below for you to paste into the environment's non-secret GitHub variable VAPID_PUBLIC_KEY"
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
  printf '%s' "${cf_api_token}" | gh secret set CLOUDFLARE_API_TOKEN --repo "${REPO}" --env "${env}"
  printf '%s' "${cf_account_id}" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "${REPO}" --env "${env}"
  echo "set: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID -> GitHub environment '${env}'"
done

unset -v cf_api_token cf_account_id

for env in "${ENVIRONMENTS[@]}"; do
  webhook_secret=$(openssl rand -hex 32)
  printf '%s' "${webhook_secret}" | npx wrangler secret put WEBHOOK_SECRET --env "${env}" --config "${HOOKS_WRANGLER}"
  unset -v webhook_secret
  echo "set: WEBHOOK_SECRET -> hooks Worker, environment '${env}'"

  vapid_json=$(npx --yes web-push generate-vapid-keys --json)
  vapid_private=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).privateKey)' "${vapid_json}")
  vapid_public=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).publicKey)' "${vapid_json}")
  unset -v vapid_json

  printf '%s' "${vapid_private}" | npx wrangler secret put VAPID_PRIVATE_KEY --env "${env}" --config "${API_WRANGLER}"
  printf '%s' "${vapid_private}" | npx wrangler secret put VAPID_PRIVATE_KEY --env "${env}" --config "${HOOKS_WRANGLER}"
  unset -v vapid_private
  echo "set: VAPID_PRIVATE_KEY -> api + hooks Workers, environment '${env}'"

  echo "VAPID public key for '${env}' (NOT a secret) — paste it into GitHub: Settings -> Environments ->"
  echo "  ${env} -> Variables -> VAPID_PUBLIC_KEY:"
  echo "  ${vapid_public}"
  unset -v vapid_public
  echo
done

echo "Done. Nothing above touched disk. Copy the three VAPID public keys now if you have not already —"
echo "they only exist in this terminal's scrollback."
