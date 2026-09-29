#!/usr/bin/env bash
# One-time (and idempotent) local setup for the Cloudflare + GitHub secrets in the owner checklist (issue
# #7, ADR 0001 Consequences). The OWNER runs this on their own machine, after `gh auth login`, `npx wrangler
# login` and `npm ci` — it is never run by an agent or in CI.
#
# Safety properties (PR #54 security review, round 2):
#   - No secret value ever reaches argv (visible to any other process on the machine via `ps`/`/proc`) or a
#     file: every value goes into `gh secret set` / `wrangler secret put` over stdin. `node` is only ever
#     given secret *names* (to check what is already set, see below) or piped non-secret data on stdin —
#     never a secret value as an argument. Only secret names are printed to this terminal.
#   - No unpinned code runs with these credentials next to it: the VAPID key pair is generated with `openssl`
#     (already on the machine, nothing downloaded — no npm package touches the private key), and the
#     Cloudflare calls use the exact `wrangler` already installed by `npm ci` (`node_modules/.bin/wrangler`)
#     — never `npx wrangler`, which could silently fetch a different version.
#   - True idempotency: a secret that already exists (by name) is left alone and reported as skipped, unless
#     `--rotate` is passed, which asks for a y/N confirmation before replacing each one individually.
#
# What it does NOT do: create the D1 databases, the Access applications, the Pages project, or the console
# GitHub App (ADR 0003, #57/#59) — those need a browser and stay click-by-click steps in
# .product-team/owner-checklist.md. It also does not set WEBHOOK_SECRET: that value must equal the console
# GitHub App's own webhook secret, so it is set by the app-setup script ADR 0003 adds, not here.
set -euo pipefail

REPO="geeera/team-console"
ENVIRONMENTS=(dev stage production)
API_WRANGLER="apps/api/wrangler.jsonc"
HOOKS_WRANGLER="apps/hooks/wrangler.jsonc"
WRANGLER="node_modules/.bin/wrangler"

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
require openssl
require node

if [ ! -f "${API_WRANGLER}" ] || [ ! -f "${HOOKS_WRANGLER}" ]; then
  echo "error: run this from the repository root (expected ${API_WRANGLER} and ${HOOKS_WRANGLER})" >&2
  exit 1
fi

if [ ! -x "${WRANGLER}" ]; then
  echo "error: ${WRANGLER} not found — run 'npm ci' first. This script never falls back to 'npx wrangler'," >&2
  echo "       which could silently download a different wrangler version onto this machine." >&2
  exit 1
fi

# --- helpers: hex -> base64url without any external hex tool (portable: sed, printf, base64) ---------------

hex_to_base64url() {
  local hex="$1" escaped
  escaped=$(printf '%s' "${hex}" | sed 's/\(..\)/\\x\1/g')
  printf '%b' "${escaped}" | base64 | tr '+/' '-_' | tr -d '=\n'
}

# VAPID is a P-256 (prime256v1) key pair: the private scalar and the uncompressed public point, both
# base64url with no padding — exactly what the `web-push` / Web Push protocol expects, generated without
# installing or running any npm package.
generate_vapid_pair() {
  local keyfile text priv_hex pub_hex
  keyfile=$(mktemp)
  openssl ecparam -name prime256v1 -genkey -noout -out "${keyfile}" 2>/dev/null
  text=$(openssl ec -in "${keyfile}" -text -noout -conv_form uncompressed 2>/dev/null)
  rm -f "${keyfile}"

  priv_hex=$(printf '%s\n' "${text}" | awk '/^priv:/{flag=1; next} /^pub:/{flag=0} flag' | tr -d ' \n:')
  pub_hex=$(printf '%s\n' "${text}" | awk '/^pub:/{flag=1; next} /^ASN1 OID:/{flag=0} flag' | tr -d ' \n:')
  # openssl drops a leading all-zero byte from the private scalar; VAPID needs the fixed 32-byte width back.
  while [ "${#priv_hex}" -lt 64 ]; do
    priv_hex="00${priv_hex}"
  done

  VAPID_PRIVATE_B64=$(hex_to_base64url "${priv_hex}")
  VAPID_PUBLIC_B64=$(hex_to_base64url "${pub_hex}")
}

# --- helpers: skip an already-set secret unless --rotate confirms replacing it ------------------------------

gh_secret_exists() {
  local env="$1" name="$2"
  gh secret list --repo "${REPO}" --env "${env}" --json name -q '.[].name' 2>/dev/null | grep -qx "${name}"
}

worker_secret_exists() {
  local config="$1" env="$2" name="$3"
  "${WRANGLER}" secret list --env "${env}" --config "${config}" 2>/dev/null \
    | node -e '
        let s = "";
        process.stdin.on("data", (d) => { s += d; });
        process.stdin.on("end", () => {
          let list;
          try { list = JSON.parse(s); } catch { list = []; }
          process.exit(list.some((x) => x.name === process.argv[1]) ? 0 : 1);
        });
      ' "${name}"
}

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

set_worker_secret() {
  local config="$1" env="$2" name="$3" value="$4" worker_label="$5"
  if worker_secret_exists "${config}" "${env}" "${name}"; then
    if ! confirm_rotate "${name} on the ${worker_label} Worker, environment '${env}'"; then
      echo "skip: ${name} already set on the ${worker_label} Worker, environment '${env}' (use --rotate to replace)"
      return 0
    fi
  fi
  printf '%s' "${value}" | "${WRANGLER}" secret put "${name}" --env "${env}" --config "${config}"
  echo "set: ${name} -> ${worker_label} Worker, environment '${env}'"
}

# --------------------------------------------------------------------------------------------------------

echo "This sets, for dev/stage/production (skipping anything already set — pass --rotate to replace):"
echo "  - CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub Environment secrets"
echo "  - a VAPID key pair: the private half as a Worker secret on 'api' and 'hooks', the public half printed"
echo "    below for you to paste into the environment's non-secret GitHub variable VAPID_PUBLIC_KEY"
echo
echo "It does NOT set WEBHOOK_SECRET — that comes from the console GitHub App (ADR 0003) so it can match the"
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
  if worker_secret_exists "${API_WRANGLER}" "${env}" VAPID_PRIVATE_KEY && ! confirm_rotate "VAPID_PRIVATE_KEY for '${env}'"; then
    echo "skip: VAPID_PRIVATE_KEY already set for '${env}' (use --rotate to replace — this breaks every existing push subscription)"
    continue
  fi

  VAPID_PRIVATE_B64=""
  VAPID_PUBLIC_B64=""
  generate_vapid_pair

  set_worker_secret "${API_WRANGLER}" "${env}" VAPID_PRIVATE_KEY "${VAPID_PRIVATE_B64}" api
  set_worker_secret "${HOOKS_WRANGLER}" "${env}" VAPID_PRIVATE_KEY "${VAPID_PRIVATE_B64}" hooks
  unset -v VAPID_PRIVATE_B64

  echo "VAPID public key for '${env}' (NOT a secret) — paste it into GitHub: Settings -> Environments ->"
  echo "  ${env} -> Variables -> VAPID_PUBLIC_KEY:"
  echo "  ${VAPID_PUBLIC_B64}"
  unset -v VAPID_PUBLIC_B64
  echo
done

echo "Done. Nothing above touched disk. Copy any freshly generated VAPID public keys now if you have not —"
echo "they only exist in this terminal's scrollback."
