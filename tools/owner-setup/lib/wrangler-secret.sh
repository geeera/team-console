# shellcheck shell=bash
# Shared by set-secrets.sh and create-apps.sh (extracted on the second occurrence — REVIEW round 1 on #61 —
# from set-secrets.sh's original, PR #54 QA round 4). Sourced, never executed directly.
#
# worker_secret_exists CONFIG ENV NAME
#   Does a Worker secret already exist? A failed listing is always an error, never "not set" — except the one
#   documented wrangler 4.124 wording for a Worker that has never been deployed (`wrangler secret list` on a
#   fresh account, before the first `wrangler secret put` creates the Worker as a draft). Relies on the
#   caller's global $WRANGLER (path to the pinned node_modules/.bin/wrangler) — same contract as before the
#   extraction, so set-secrets.sh's call sites and stub test did not need to change.
worker_secret_exists() {
  local config="$1" env="$2" name="$3" listing listing_err

  # stdout and stderr are captured separately: mixing them (2>&1) would feed a stderr warning wrangler prints
  # on an otherwise *successful* list (an update notice, a config warning) into the JSON parser below and
  # misreport it as a parse failure (QA round 4).
  listing_err=$(mktemp)
  if listing=$("${WRANGLER}" secret list --env "${env}" --config "${config}" 2>"${listing_err}"); then
    rm -f "${listing_err}"
  else
    local stderr_text
    stderr_text=$(cat "${listing_err}")
    rm -f "${listing_err}"

    # wrangler 4.124.0 (the version pinned in package.json and deploy.yml) throws exactly this error — see
    # `isWorkerNotFoundError` in packages/wrangler/src/secret/index.ts — when `secret list` targets a Worker
    # that has never been deployed. On a fresh account that is every Worker until `wrangler secret put` below
    # creates it as a draft: nothing earlier in the checklist deploys one. Only this specific, pinned wording
    # is treated as "not set"; any other failure (auth, network, a renamed Worker) still aborts the script.
    # Re-verify this text if `wranglerVersion`/`package.json`'s wrangler version ever changes.
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
