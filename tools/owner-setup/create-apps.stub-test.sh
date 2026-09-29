#!/usr/bin/env bash
# Stub-based integration test for create-apps.sh (#61, ADR 0003): no network to the real GitHub or Cloudflare,
# `gh` and `wrangler` are shell stubs on PATH, and the one real outbound call the script makes (POST
# /app-manifests/{code}/conversions) is pointed at a throwaway local Node server via
# CREATE_APPS_GITHUB_API_BASE — an env var the real script never documents in the checklist and only this
# test sets.
#
# CRITICAL isolation, same rule as set-secrets.stub-test.sh (an earlier incident on this repo had a `gh`
# scoping bug reach the real, authenticated `gh` and call the real API): every invocation scrubs
# GH_TOKEN/GITHUB_TOKEN/PT_*, uses an isolated HOME/GH_CONFIG_DIR, and hard-asserts `command -v gh`/`wrangler`
# resolve to the stubs before create-apps.sh ever runs — refusing to continue otherwise.
#
# Scenarios:
#   1. Happy path: the local manifest page is fetched, the state it carries is played back on /callback, the
#      fake GitHub conversion endpoint answers, and the (fake) private key, client secret and webhook secret
#      are piped into the stub wrangler — never printed.
#   2. State mismatch on /callback: the script must abort without setting anything.
#   3. Idempotency: a second run against an environment whose api Worker already has
#      GITHUB_APP_CLIENT_SECRET set (from scenario 1) is skipped without touching the network at all.
# Deliberately not `set -e`: every assertion is checked explicitly so one failure does not hide the next.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILURES=0

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

new_scratch_repo() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/repo/apps/api" "${dir}/repo/apps/hooks" "${dir}/repo/node_modules/.bin" \
    "${dir}/repo/tools/owner-setup" "${dir}/bin" "${dir}/state" "${dir}/home/gh-config"
  cp "${SCRIPT_DIR}/create-apps.sh" "${dir}/repo/tools/owner-setup/create-apps.sh"
  cp "${SCRIPT_DIR}/create-apps-server.js" "${dir}/repo/tools/owner-setup/create-apps-server.js"
  : > "${dir}/repo/apps/api/wrangler.jsonc"
  : > "${dir}/repo/apps/hooks/wrangler.jsonc"
  printf '%s' "${dir}"
}

install_stub_wrangler() {
  local bin="${1}/repo/node_modules/.bin/wrangler"
  cat > "${bin}" <<'STUB'
#!/bin/bash
state_dir="${WRANGLER_STATE_DIR:?WRANGLER_STATE_DIR not set}"
env=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  if [ "${arg}" = "--env" ]; then
    j=$((i + 1))
    env="${!j}"
  fi
done

if [ "$1 $2" = "secret list" ]; then
  if [ -f "${state_dir}/${env}.GITHUB_APP_CLIENT_SECRET" ]; then
    echo '[{"name":"GITHUB_APP_CLIENT_SECRET"}]'
    exit 0
  fi
  echo "✘ [ERROR] Worker \"team-console-${env}\" (env: ${env}) not found." >&2
  echo 'If this is a new Worker, run `wrangler deploy` first to create it.' >&2
  exit 1
fi

if [ "$1 $2" = "secret put" ]; then
  name="$3"
  cat >/dev/null
  touch "${state_dir}/${env}.${name}"
  exit 0
fi

exit 0
STUB
  chmod +x "${bin}"
}

install_stub_gh() {
  local bin="${1}/bin/gh"
  cat > "${bin}" <<'STUB'
#!/bin/bash
if [ "$1 $2" = "api user" ]; then
  echo "stub-owner-login"
  exit 0
fi
if [ "$1 $2" = "variable set" ]; then
  cat >/dev/null
  exit 0
fi
exit 0
STUB
  chmod +x "${bin}"
}

# Real PKCS#1 key so the script's own `openssl pkcs8 -topk8` conversion (not stubbed — it is a system binary
# in the credential path, same reasoning as set-secrets.sh keeping VAPID generation off a stubbed tool) has
# something valid to convert. The key file is thrown away immediately after being read into the fixture JSON.
make_fixture_json() {
  local dir="$1" pem_file fixture
  pem_file="${dir}/fixture.pem"
  openssl genrsa -out "${pem_file}" 2048 >/dev/null 2>&1
  fixture=$(node -e '
      const fs = require("fs");
      const pem = fs.readFileSync(process.argv[1], "utf8");
      process.stdout.write(JSON.stringify({
        id: 424242,
        client_id: "Iv1.stubclientid",
        client_secret: "stub-client-secret-value",
        webhook_secret: "stub-webhook-secret-value",
        pem,
        slug: "team-console-dev-test",
        owner: { login: "stub-owner-login" },
      }));
    ' "${pem_file}")
  rm -f "${pem_file}"
  printf '%s' "${fixture}"
}

# Fake GitHub: answers only the one endpoint create-apps-server.js calls. Prints its PID so the caller can
# kill it once the scenario is done.
start_fake_github() {
  local dir="$1" port="$2" fixture="$3"
  cat > "${dir}/fake-github.js" <<'JS'
const http = require('http');
const port = Number(process.env.FAKE_GITHUB_PORT);
const fixture = process.env.FAKE_GITHUB_FIXTURE;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && /^\/app-manifests\/[^/]+\/conversions$/.test(req.url)) {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(fixture);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
JS
  # Redirected away from this function's own stdout/stderr on purpose: this call is made from inside
  # `$(start_fake_github ...)` (a command substitution), and a *backgrounded* child that keeps the
  # substitution's stdout pipe open (inherited, never closed) makes the substitution block forever waiting
  # for EOF — caught while developing this test, it looked exactly like a hang in create-apps.sh itself.
  FAKE_GITHUB_PORT="${port}" FAKE_GITHUB_FIXTURE="${fixture}" node "${dir}/fake-github.js" \
    >"${dir}/fake-github.log" 2>&1 &
  echo $!
}

# Runs create-apps.sh with the same isolation discipline as set-secrets.stub-test.sh, hard-asserting `gh` and
# `wrangler` resolve to the stubs before the script under test ever runs.
# $1 dir, $2 fake GitHub base URL, $3 local server port (0 = OS-assigned), $4 timeout ms, rest: script args.
run_create_apps() {
  local dir="$1" api_base="$2" port="$3" timeout_ms="$4"
  shift 4
  (
    cd "${dir}/repo" || exit 127
    export PATH="${dir}/bin:${dir}/repo/node_modules/.bin:${PATH}"
    export HOME="${dir}/home"
    export GH_CONFIG_DIR="${dir}/home/gh-config"
    export WRANGLER_STATE_DIR="${dir}/state"
    export CREATE_APPS_GITHUB_API_BASE="${api_base}"
    export CREATE_APPS_PORT="${port}"
    export CREATE_APPS_TIMEOUT_MS="${timeout_ms}"
    # Never let this test touch a real browser — see the comment next to CREATE_APPS_NO_OPEN in
    # create-apps.sh / create-apps-server.js.
    export CREATE_APPS_NO_OPEN=1

    unset GH_TOKEN GITHUB_TOKEN
    # shellcheck disable=SC2046 # word-splitting is the point: `compgen -v PT_` lists variable *names*.
    unset $(compgen -v PT_ || true)

    resolved_gh=$(command -v gh)
    if [ "${resolved_gh}" != "${dir}/bin/gh" ]; then
      echo "TEST HARNESS BUG: 'gh' resolved to '${resolved_gh}', not the stub at '${dir}/bin/gh' — refusing to run create-apps.sh, which would otherwise touch a real account" >&2
      exit 126
    fi

    resolved_wrangler=$(command -v wrangler || true)
    if [ -n "${resolved_wrangler}" ] && [ "${resolved_wrangler}" != "${dir}/repo/node_modules/.bin/wrangler" ]; then
      echo "TEST HARNESS BUG: a 'wrangler' other than the stub is reachable on PATH ('${resolved_wrangler}') — refusing to run" >&2
      exit 126
    fi

    bash tools/owner-setup/create-apps.sh "$@"
  ) 2>&1
}

wait_for_http_200() {
  local url="$1" tries=50
  while [ "${tries}" -gt 0 ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 0.1
  done
  return 1
}

# ------------------------------------------------------------------------------------------------------------
echo "=== scenario 1: happy path (manifest page -> callback -> conversion -> secrets piped in) ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}"
fixture=$(make_fixture_json "${dir}")
fake_github_pid=$(start_fake_github "${dir}" 18943 "${fixture}")
unset fixture

outfile="${dir}/scenario1.out"
run_create_apps "${dir}" "http://127.0.0.1:18943" 18944 5000 --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!

if wait_for_http_200 "http://127.0.0.1:18944/"; then
  page=$(curl -s "http://127.0.0.1:18944/")
  extracted_state=$(printf '%s' "${page}" | grep -oE 'state=[0-9a-f]+' | head -n1 | cut -d= -f2)
  if [ -z "${extracted_state}" ]; then
    fail "scenario 1: could not extract 'state' from the manifest page"
  else
    curl -s -o /dev/null "http://127.0.0.1:18944/callback?code=fake-manifest-code&state=${extracted_state}"
  fi
else
  fail "scenario 1: create-apps.sh's local server never answered on 127.0.0.1:18944"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")

if [ "${rc}" -ne 0 ]; then
  fail "expected create-apps.sh to succeed on the happy path, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "set: GITHUB_APP_PRIVATE_KEY -> api Worker, environment 'dev'"; then
  fail "expected GITHUB_APP_PRIVATE_KEY to be set on 'api'"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "set: GITHUB_APP_CLIENT_SECRET -> api Worker, environment 'dev'"; then
  fail "expected GITHUB_APP_CLIENT_SECRET to be set on 'api'"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "set: WEBHOOK_SECRET -> hooks Worker, environment 'dev'"; then
  fail "expected WEBHOOK_SECRET to be set on 'hooks'"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "set: TOKEN_ENCRYPTION_KEY -> api Worker, environment 'dev'"; then
  fail "expected TOKEN_ENCRYPTION_KEY to be set on 'api'"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "CONSOLE_GITHUB_APP_ID, CONSOLE_GITHUB_APP_CLIENT_ID, OWNER_GITHUB_LOGIN -> GitHub environment 'dev'"; then
  fail "expected the three GitHub Environment variables to be reported as set"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -qF "stub-client-secret-value"; then
  fail "the fake client secret value leaked into create-apps.sh's output"
elif printf '%s' "${output}" | grep -qF "stub-webhook-secret-value"; then
  fail "the fake webhook secret value leaked into create-apps.sh's output"
elif printf '%s' "${output}" | grep -qF "PRIVATE KEY"; then
  fail "the fake private key leaked into create-apps.sh's output"
else
  echo "ok: happy path sets all four Worker secrets and the three GitHub variables, prints only names"
fi

rm -rf "${dir}"

# ------------------------------------------------------------------------------------------------------------
echo
echo "=== scenario 2: state mismatch on /callback must abort, nothing gets set ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}"
fixture=$(make_fixture_json "${dir}")
fake_github_pid=$(start_fake_github "${dir}" 18945 "${fixture}")
unset fixture

outfile="${dir}/scenario2.out"
run_create_apps "${dir}" "http://127.0.0.1:18945" 18946 5000 --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!

if wait_for_http_200 "http://127.0.0.1:18946/"; then
  curl -s -o /dev/null "http://127.0.0.1:18946/callback?code=fake-manifest-code&state=deliberately-wrong-state"
else
  fail "scenario 2: create-apps.sh's local server never answered on 127.0.0.1:18946"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")

if [ "${rc}" -eq 0 ]; then
  fail "expected create-apps.sh to abort on a state mismatch, it exited 0"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "a state mismatch still resulted in a secret being set"
  printf '%s\n' "${output}"
else
  echo "ok: a state mismatch aborts create-apps.sh without setting anything"
fi

rm -rf "${dir}"

# ------------------------------------------------------------------------------------------------------------
echo
echo "=== scenario 3: an environment whose app already exists is skipped, no network needed ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}"
mkdir -p "${dir}/state"
touch "${dir}/state/dev.GITHUB_APP_CLIENT_SECRET"

output=$(run_create_apps "${dir}" "http://127.0.0.1:1" 0 1000 --env dev --subdomain test-subdomain)
rc=$?

if [ "${rc}" -ne 0 ]; then
  fail "expected create-apps.sh to exit 0 when skipping an existing app, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "skip: team-console-dev appears to already exist"; then
  fail "expected the 'appears to already exist' skip message"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "an environment that should have been skipped still had secrets set"
  printf '%s\n' "${output}"
else
  echo "ok: an environment with an existing app is skipped without contacting the network"
fi

rm -rf "${dir}"

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "ok: create-apps.sh stub scenarios passed"
  exit 0
else
  echo "${FAILURES} scenario(s) failed"
  exit 1
fi
