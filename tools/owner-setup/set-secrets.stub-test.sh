#!/usr/bin/env bash
# Stub-based integration test for set-secrets.sh (PR #54 QA round 4): no network, no real gh/wrangler
# account, `gh` and `wrangler` are shell stubs on PATH inside a scratch copy of the repo layout the script
# expects. Exercises the two cases QA reproduced:
#   1. Fresh account: `wrangler secret list` fails with wrangler 4.124's "Worker ... not found" (the Worker
#      does not exist until `wrangler secret put` creates it as a draft) — the script must still succeed and
#      set VAPID_PRIVATE_KEY.
#   2. An unrelated wrangler failure (auth) on the same call — the script must abort, never silently treat it
#      as "not set".
# Deliberately not `set -e`: every command's exit code is checked explicitly so one failing assertion does
# not hide the next.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILURES=0

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

# A fresh scratch repo with only what set-secrets.sh looks for: the two wrangler configs (used just for their
# existence, contents don't matter here) and a `node_modules/.bin/wrangler` stub.
new_scratch_repo() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/repo/apps/api" "${dir}/repo/apps/hooks" "${dir}/repo/node_modules/.bin" "${dir}/repo/tools/owner-setup" "${dir}/bin"
  cp "${SCRIPT_DIR}/set-secrets.sh" "${dir}/repo/tools/owner-setup/set-secrets.sh"
  cp "${SCRIPT_DIR}/vapid-keygen.js" "${dir}/repo/tools/owner-setup/vapid-keygen.js"
  : > "${dir}/repo/apps/api/wrangler.jsonc"
  : > "${dir}/repo/apps/hooks/wrangler.jsonc"
  printf '%s' "${dir}"
}

# $1: "not-found" (wrangler 4.124's real wording for a Worker that was never deployed) or "auth" (an
# unrelated failure that must still abort the script).
# Exact wording from wrangler 4.124.0's isWorkerNotFoundError (packages/wrangler/src/secret/index.ts) —
# matches what set-secrets.sh's worker_secret_exists greps for. The backticks below are literal text for the
# generated stub, not command substitution.
# shellcheck disable=SC2016
STUB_NOT_FOUND_ERROR='✘ [ERROR] Worker "team-console-dev" (env: dev) not found.
If this is a new Worker, run `wrangler deploy` first to create it.'

# shellcheck disable=SC2016
STUB_AUTH_ERROR='✘ [ERROR] You are not authenticated. Please run `wrangler login`.'

install_stub_wrangler() {
  local dir="$1" mode="$2" bin="${1}/repo/node_modules/.bin/wrangler" error_text
  if [ "${mode}" = "not-found" ]; then
    error_text="${STUB_NOT_FOUND_ERROR}"
  else
    error_text="${STUB_AUTH_ERROR}"
  fi
  cat > "${bin}" <<STUB
#!/bin/bash
if [ "\$1 \$2" = "secret list" ]; then
  echo '${error_text}' >&2
  exit 1
fi
if [ "\$1 \$2" = "secret put" ]; then cat >/dev/null; exit 0; fi
exit 0
STUB
  chmod +x "${bin}"
}

install_stub_gh() {
  local dir="$1" bin="${1}/bin/gh"
  cat > "${bin}" <<'STUB'
#!/bin/bash
case "$1 $2" in
  "secret list") exit 0 ;;
  "secret set") cat >/dev/null; exit 0 ;;
esac
exit 0
STUB
  chmod +x "${bin}"
}

run_set_secrets() {
  local dir="$1"
  (
    cd "${dir}/repo" || exit 127
    # `VAR=val cmd1 | cmd2` only scopes VAR to cmd1 — it silently did NOT reach `bash set-secrets.sh` here in
    # an earlier version of this test, which then resolved the real system `gh` and, on one run before this
    # was caught, called the real `gh secret set` against the real repository (incident recorded on PR #54).
    # `export` inside this already-isolated subshell, plus an isolated `HOME`/`GH_CONFIG_DIR` with no stored
    # credentials as defense in depth (a `gh` binary found by mistake would then fail closed, not succeed
    # against a real account), plus a hard assertion that `gh`/`wrangler` resolve to the stubs before the
    # script under test ever runs.
    export PATH="${dir}/bin:${dir}/repo/node_modules/.bin:${PATH}"
    export HOME="${dir}/home"
    export GH_CONFIG_DIR="${dir}/home/gh-config"
    mkdir -p "${HOME}" "${GH_CONFIG_DIR}"
    unset GH_TOKEN GITHUB_TOKEN

    resolved_gh=$(command -v gh)
    if [ "${resolved_gh}" != "${dir}/bin/gh" ]; then
      echo "TEST HARNESS BUG: 'gh' resolved to '${resolved_gh}', not the stub at '${dir}/bin/gh' — refusing to run set-secrets.sh, which would otherwise touch a real account" >&2
      exit 126
    fi

    printf 'stub-cloudflare-token\nstub-account-id\n' | bash tools/owner-setup/set-secrets.sh
  ) 2>&1
}

echo "=== scenario 1: fresh account (Worker not found on the first secret list) ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}" not-found
install_stub_gh "${dir}"
output=$(run_set_secrets "${dir}")
rc=$?
rm -rf "${dir}"

if [ "${rc}" -ne 0 ]; then
  fail "expected set-secrets.sh to succeed on a fresh account, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q 'set: VAPID_PRIVATE_KEY -> api Worker'; then
  fail "expected VAPID_PRIVATE_KEY to be set on 'api' despite the fresh-account 'not found' error"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q 'set: VAPID_PRIVATE_KEY -> hooks Worker'; then
  fail "expected VAPID_PRIVATE_KEY to be set on 'hooks' despite the fresh-account 'not found' error"
  printf '%s\n' "${output}"
else
  echo "ok: a fresh account still gets VAPID_PRIVATE_KEY on both Workers"
fi

echo
echo "=== scenario 2: unrelated wrangler failure (auth) must abort, never be treated as 'not set' ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}" auth
install_stub_gh "${dir}"
output=$(run_set_secrets "${dir}")
rc=$?
rm -rf "${dir}"

if [ "${rc}" -eq 0 ]; then
  fail "expected set-secrets.sh to abort on an unrelated wrangler failure, it exited 0"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q 'set: VAPID_PRIVATE_KEY'; then
  fail "an unrelated wrangler failure was treated as 'not set' — VAPID_PRIVATE_KEY was set anyway"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q 'cannot tell whether'; then
  fail "expected the 'cannot tell whether ... is already set' abort message"
  printf '%s\n' "${output}"
else
  echo "ok: an unrelated wrangler failure aborts the script"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "ok: set-secrets.sh stub scenarios passed"
  exit 0
else
  echo "${FAILURES} scenario(s) failed"
  exit 1
fi
