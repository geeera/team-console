#!/usr/bin/env bash
# Stub-based integration test for create-apps.sh (#61, ADR 0003): no network to the real GitHub or Cloudflare,
# `gh` and `wrangler` are shell stubs on PATH, and the one real outbound call the script makes (POST
# /app-manifests/{code}/conversions) is pointed at a throwaway local Node server via
# CREATE_APPS_GITHUB_API_BASE — an env var the real script never documents in the checklist and only this
# test sets (and only when CREATE_APPS_TEST_MODE=1, exactly like create-apps-server.js requires — scenario 7
# below is what happens when a test forgets that flag).
#
# CRITICAL isolation, same rule as set-secrets.stub-test.sh (an earlier incident on this repo had a `gh`
# scoping bug reach the real, authenticated `gh` and call the real API): every invocation scrubs
# GH_TOKEN/GITHUB_TOKEN/PT_*, uses an isolated HOME/GH_CONFIG_DIR, and hard-asserts `command -v gh`/`wrangler`
# resolve to the stubs before create-apps.sh ever runs — refusing to continue otherwise.
#
# Determinism (REVIEW + SECURITY round 2 on PR #65): every server in this file — the fake GitHub conversion
# endpoint and create-apps.sh's own local listener — binds port 0 (OS-assigned) and the test *waits* for it to
# actually be reachable before driving traffic at it; a fixed port was observed to collide often enough to
# flake a required CI check, and reading a not-yet-open socket produced a different, reproducible flake
# (`ECONNREFUSED`). `process_alive` retries briefly for the same reason.
#
# Scenarios (QA + SECURITY review, both rounds):
#   1. Happy path: the served manifest is asserted field-by-field against ADR 0003; every value the stubs
#      receive is asserted by content; GITHUB_APP_CLIENT_SECRET is asserted to be written *last*.
#   2. Robustness: a request with the wrong `Host`, then one with no `state`, then one with the wrong `state`,
#      must each be rejected without aborting the run — only a subsequent, correct callback finishes it.
#   3. The conversion response is rejected (nothing set) when its `name` or `owner` doesn't match, and the
#      breadcrumb is updated to point at the app GitHub actually created instead of the one we asked for.
#   4. `gh` authenticated as someone other than the repository owner aborts before the local server starts.
#   5. Idempotency: an environment whose api Worker already has GITHUB_APP_CLIENT_SECRET set is skipped.
#   6. A half-created app (breadcrumb recorded, no final secret) is reported; declining leaves it alone.
#   7. CREATE_APPS_GITHUB_API_BASE is ignored (a warning only) unless CREATE_APPS_TEST_MODE=1 — proven by the
#      warning and zero hits on the fake server; the run is left to its own (short) timeout, never driven to
#      the real api.github.com (SECURITY round 2).
#   8. An invalid workers.dev subdomain is rejected before anything else runs.
#   9. A `wrangler secret put` failure mid-way prints the recovery hint with the app's settings URL, and never
#      writes the final GITHUB_APP_CLIENT_SECRET marker (SECURITY round 2 note A).
#  10. A breadcrumb lookup failure that is *not* "not found" (an auth/network error) aborts loudly instead of
#      being read as "no half-created app" (SECURITY round 2 note C).
# Deliberately not `set -e`: every assertion is checked explicitly so one failure does not hide the next.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILURES=0
DEFAULT_OWNER="stub-owner-login"

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

new_scratch_repo() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/repo/apps/api" "${dir}/repo/apps/hooks" "${dir}/repo/node_modules/.bin" \
    "${dir}/repo/tools/owner-setup/lib" "${dir}/bin" "${dir}/state" "${dir}/home/gh-config"
  cp "${SCRIPT_DIR}/create-apps.sh" "${dir}/repo/tools/owner-setup/create-apps.sh"
  cp "${SCRIPT_DIR}/create-apps-server.js" "${dir}/repo/tools/owner-setup/create-apps-server.js"
  cp "${SCRIPT_DIR}/lib/wrangler-secret.sh" "${dir}/repo/tools/owner-setup/lib/wrangler-secret.sh"
  : > "${dir}/repo/apps/api/wrangler.jsonc"
  : > "${dir}/repo/apps/hooks/wrangler.jsonc"
  printf '%s' "${dir}"
}

# Worker secret content is recorded (not just its presence) so scenario 1 can assert the exact bytes each name
# received and the *order* secrets were written in. WRANGLER_FAIL_PUT=<name> (env, not arg — set by the caller
# before backgrounding) makes `secret put <name>` fail after consuming stdin, for scenario 9.
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
  content=$(cat)
  if [ -n "${WRANGLER_FAIL_PUT:-}" ] && [ "${name}" = "${WRANGLER_FAIL_PUT}" ]; then
    echo "✘ [ERROR] simulated failure putting ${name}" >&2
    exit 1
  fi
  printf '%s' "${content}" > "${state_dir}/${env}.${name}"
  echo "$(date +%s%N) ${env} ${name}" >> "${state_dir}/order.log"
  exit 0
fi

exit 0
STUB
  chmod +x "${bin}"
}

# $2/$3: what `gh api repos/.../--jq .owner.login` and `gh api user --jq .login` answer respectively — the two
# differ only in scenario 4 (owner mismatch). `variable set` and the breadcrumb read (now `gh api
# repos/.../environments/<env>/variables/CONSOLE_GITHUB_APP_SLUG`, SECURITY round 2 note C — not `gh variable
# get`, whose "not found" wording isn't documented) are recorded in/read from the same scratch state
# directory the wrangler stub uses. GH_BREADCRUMB_FAIL=1 (env) makes the breadcrumb read fail with something
# other than "not found", for scenario 10.
install_stub_gh() {
  local dir="$1" repo_owner="$2" current_user="$3" bin="${1}/bin/gh"
  cat > "${bin}" <<STUB
#!/bin/bash
state_dir="\${GH_STATE_DIR:?GH_STATE_DIR not set}"
if [ "\$1" = "api" ] && [ "\$2" = "repos/geeera/team-console" ]; then
  echo "${repo_owner}"
  exit 0
fi
if [ "\$1 \$2" = "api user" ]; then
  echo "${current_user}"
  exit 0
fi
if [ "\$1" = "api" ]; then
  case "\$2" in
    repos/geeera/team-console/environments/*/variables/CONSOLE_GITHUB_APP_SLUG)
      if [ -n "\${GH_BREADCRUMB_FAIL:-}" ]; then
        echo "gh: authentication failed (HTTP 403)" >&2
        exit 1
      fi
      env_name=\$(printf '%s' "\$2" | sed -E 's#repos/geeera/team-console/environments/([^/]+)/variables/.*#\1#')
      f="\${state_dir}/gh-var.\${env_name}.CONSOLE_GITHUB_APP_SLUG"
      if [ -f "\${f}" ]; then
        cat "\${f}"
        exit 0
      fi
      echo "gh: Not Found (HTTP 404)" >&2
      exit 1
      ;;
  esac
fi
if [ "\$1 \$2" = "variable set" ]; then
  name="\$3"
  env=""
  for ((i = 1; i <= \$#; i++)); do
    arg="\${!i}"
    if [ "\${arg}" = "--env" ]; then j=\$((i + 1)); env="\${!j}"; fi
  done
  content=\$(cat)
  printf '%s' "\${content}" > "\${state_dir}/gh-var.\${env}.\${name}"
  exit 0
fi
exit 0
STUB
  chmod +x "${bin}"
}

# Real PKCS#1 key so the script's own `openssl pkcs8 -topk8` conversion (not stubbed — it is a system binary
# in the credential path, same reasoning as set-secrets.sh keeping VAPID generation off a stubbed tool) has
# something valid to convert. The key file is thrown away immediately after being read into the fixture JSON.
# $4/$5/$6 default to a fixture that matches $2 (app name) and $3 (owner login), type "User" — scenario 3
# overrides them to build a mismatched conversion response.
make_fixture_json() {
  local dir="$1" fixture_name="${4:-$2}" fixture_owner="${5:-$3}" fixture_owner_type="${6:-User}" pem_file fixture
  pem_file="${dir}/fixture-${RANDOM}.pem"
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
        name: process.argv[2],
        slug: process.argv[2],
        owner: { login: process.argv[3], type: process.argv[4] },
      }));
    ' "${pem_file}" "${fixture_name}" "${fixture_owner}" "${fixture_owner_type}")
  rm -f "${pem_file}"
  printf '%s' "${fixture}"
}

# Fake GitHub: answers only the one endpoint create-apps-server.js calls, binds port 0, counts hits, and waits
# for its own listener before returning — prints "<port> <pid>" (REVIEW round 2: the previous version returned
# immediately after backgrounding, which raced create-apps-server.js's very first request often enough to
# flake `security.yml`'s required workflow-lint job).
start_fake_github() {
  local dir="$1" fixture="$2" port_file
  cat > "${dir}/fake-github.js" <<'JS'
const http = require('http');
const fs = require('fs');
const fixture = process.env.FAKE_GITHUB_FIXTURE;
const hitFile = process.env.FAKE_GITHUB_HIT_FILE;
const portFile = process.env.FAKE_GITHUB_PORT_FILE;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && /^\/app-manifests\/[^/]+\/conversions$/.test(req.url)) {
    if (hitFile) fs.appendFileSync(hitFile, '1\n');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(fixture);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
JS
  port_file="${dir}/fake-github-${RANDOM}.port"
  # Redirected away from this function's own stdout/stderr on purpose: this call is made from inside
  # `$(start_fake_github ...)` (a command substitution), and a *backgrounded* child that keeps the
  # substitution's stdout pipe open (inherited, never closed) makes the substitution block forever waiting
  # for EOF — caught while developing this test, it looked exactly like a hang in create-apps.sh itself.
  FAKE_GITHUB_FIXTURE="${fixture}" FAKE_GITHUB_HIT_FILE="${dir}/fake-github-hits" FAKE_GITHUB_PORT_FILE="${port_file}" \
    node "${dir}/fake-github.js" >"${dir}/fake-github.log" 2>&1 &
  local pid=$! tries=200
  while [ ! -s "${port_file}" ] && [ "${tries}" -gt 0 ]; do
    sleep 0.02
    tries=$((tries - 1))
  done
  if [ ! -s "${port_file}" ]; then
    echo "0 ${pid}"
    return 1
  fi
  echo "$(cat "${port_file}") ${pid}"
}

fake_github_hit_count() {
  local dir="$1"
  if [ -f "${dir}/fake-github-hits" ]; then
    wc -l < "${dir}/fake-github-hits" | tr -d ' '
  else
    echo 0
  fi
}

# Runs create-apps.sh with the same isolation discipline as set-secrets.stub-test.sh, hard-asserting `gh` and
# `wrangler` resolve to the stubs before the script under test ever runs. Always binds its own listener on
# port 0 (see the file header) — the caller discovers the chosen port with wait_for_create_apps_port.
# $1 dir, $2 fake GitHub base URL ("" to leave unset), $3 timeout ms, $4 "1"/"" for CREATE_APPS_TEST_MODE,
# rest: script args. Reads stdin from the caller (scenario 6 pipes an answer to the confirmation prompt).
run_create_apps() {
  local dir="$1" api_base="$2" timeout_ms="$3" test_mode="$4"
  shift 4
  (
    cd "${dir}/repo" || exit 127
    export PATH="${dir}/bin:${dir}/repo/node_modules/.bin:${PATH}"
    export HOME="${dir}/home"
    export GH_CONFIG_DIR="${dir}/home/gh-config"
    export WRANGLER_STATE_DIR="${dir}/state"
    export GH_STATE_DIR="${dir}/state"
    export CREATE_APPS_GITHUB_API_BASE="${api_base}"
    export CREATE_APPS_TEST_MODE="${test_mode}"
    export CREATE_APPS_PORT=0
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
  local url="$1" tries=200
  while [ "${tries}" -gt 0 ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null)" = "200" ]; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 0.05
  done
  return 1
}

# create-apps.sh always logs "Open this URL in your browser" followed by its own 127.0.0.1:<port>/ the moment
# it starts listening (before it ever needs the fake GitHub server) — polling the captured output for that
# line is how the test learns the OS-assigned port without create-apps.sh needing a test-only reporting hook.
wait_for_create_apps_port() {
  local outfile="$1" tries=200 line
  while [ "${tries}" -gt 0 ]; do
    line=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/$' "${outfile}" 2>/dev/null | head -n1)
    if [ -n "${line}" ]; then
      printf '%s' "${line}" | sed -E 's#.*:([0-9]+)/$#\1#'
      return 0
    fi
    tries=$((tries - 1))
    sleep 0.05
  done
  return 1
}

# Retries briefly before concluding a background job is dead — SECURITY round 2 note D observed a `kill -0`
# false negative under load; a genuinely dead process still fails every retry.
process_alive() {
  local pid="$1" tries=10
  while [ "${tries}" -gt 0 ]; do
    if kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 0.05
  done
  return 1
}

# ============================================================================================================
echo "=== scenario 1: happy path — manifest content, exact secret/variable values, and write order ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}")
read -r fake_github_port fake_github_pid <<< "$(start_fake_github "${dir}" "${fixture}")"
unset fixture

outfile="${dir}/scenario1.out"
run_create_apps "${dir}" "http://127.0.0.1:${fake_github_port}" 5000 1 --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!

if local_port=$(wait_for_create_apps_port "${outfile}") && wait_for_http_200 "http://127.0.0.1:${local_port}/"; then
  curl -s -o "${dir}/page.html" "http://127.0.0.1:${local_port}/" >/dev/null
  extracted_state=$(grep -oE 'state=[0-9a-f]+' "${dir}/page.html" | head -n1 | cut -d= -f2)
  cat > "${dir}/assert-manifest.js" <<'JS'
const fs = require('fs');
const [, , pageFile, appName, callbackUrl, webhookUrl] = process.argv;
const html = fs.readFileSync(pageFile, 'utf8');
const m = html.match(/value='([^']*)'/);
if (!m) {
  console.error('no manifest value found in the served page');
  process.exit(1);
}
const unescape = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
let manifest;
try {
  manifest = JSON.parse(unescape(m[1]));
} catch (e) {
  console.error('manifest is not valid JSON: ' + e.message);
  process.exit(1);
}
const { redirect_url: redirectUrl, ...rest } = manifest;
const expected = {
  name: appName,
  url: 'https://github.com/geeera/team-console',
  hook_attributes: { url: webhookUrl },
  callback_urls: [callbackUrl],
  public: false,
  request_oauth_on_install: false,
  default_permissions: { metadata: 'read', issues: 'write', pull_requests: 'read', contents: 'read', actions: 'read' },
  default_events: ['issues', 'issue_comment', 'pull_request', 'workflow_run', 'release', 'push'],
};
if (JSON.stringify(rest) !== JSON.stringify(expected)) {
  console.error('manifest mismatch.\nexpected: ' + JSON.stringify(expected) + '\nactual:   ' + JSON.stringify(rest));
  process.exit(1);
}
if (!redirectUrl || !redirectUrl.startsWith('http://127.0.0.1:')) {
  console.error('redirect_url looks wrong: ' + redirectUrl);
  process.exit(1);
}
JS
  if ! node "${dir}/assert-manifest.js" "${dir}/page.html" "team-console-dev" \
    "https://team-console-dev.test-subdomain.workers.dev/api/v1/github/callback" \
    "https://team-console-hooks-dev.test-subdomain.workers.dev/hooks/github"; then
    fail "scenario 1: the served manifest does not match ADR 0003"
  fi
  if [ -z "${extracted_state}" ]; then
    fail "scenario 1: could not extract 'state' from the manifest page"
  else
    curl -s -o /dev/null -H "Host: 127.0.0.1:${local_port}" \
      "http://127.0.0.1:${local_port}/callback?code=fake-manifest-code&state=${extracted_state}"
  fi
else
  fail "scenario 1: create-apps.sh's local server never became reachable"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")

check_scenario1_content() {
  [ -f "${dir}/state/dev.GITHUB_APP_PRIVATE_KEY" ] || {
    fail "GITHUB_APP_PRIVATE_KEY was never written"
    return
  }
  case "$(cat "${dir}/state/dev.GITHUB_APP_PRIVATE_KEY")" in
    -----BEGIN\ PRIVATE\ KEY-----*) ;;
    *) fail "GITHUB_APP_PRIVATE_KEY does not start with the PKCS#8 header" ;;
  esac

  [ "$(cat "${dir}/state/dev.GITHUB_APP_CLIENT_SECRET" 2>/dev/null)" = "stub-client-secret-value" ] \
    || fail "GITHUB_APP_CLIENT_SECRET on the api Worker does not equal the fixture value"
  [ "$(cat "${dir}/state/dev.WEBHOOK_SECRET" 2>/dev/null)" = "stub-webhook-secret-value" ] \
    || fail "WEBHOOK_SECRET on the hooks Worker does not equal the fixture value"

  local token_key_bytes
  token_key_bytes=$(base64 -d < "${dir}/state/dev.TOKEN_ENCRYPTION_KEY" 2>/dev/null | wc -c | tr -d ' ')
  [ "${token_key_bytes}" = "32" ] || fail "TOKEN_ENCRYPTION_KEY decodes to ${token_key_bytes} bytes, expected 32"

  [ "$(cat "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_ID" 2>/dev/null)" = "424242" ] \
    || fail "CONSOLE_GITHUB_APP_ID does not equal the fixture id"
  [ "$(cat "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_CLIENT_ID" 2>/dev/null)" = "Iv1.stubclientid" ] \
    || fail "CONSOLE_GITHUB_APP_CLIENT_ID does not equal the fixture client_id"
  [ "$(cat "${dir}/state/gh-var.dev.OWNER_GITHUB_LOGIN" 2>/dev/null)" = "${DEFAULT_OWNER}" ] \
    || fail "OWNER_GITHUB_LOGIN was not set to the repository owner"
  [ "$(cat "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_SLUG" 2>/dev/null)" = "team-console-dev" ] \
    || fail "CONSOLE_GITHUB_APP_SLUG does not equal the fixture slug"

  if [ ! -f "${dir}/state/order.log" ]; then
    fail "no secret write order was recorded"
    return
  fi
  local last_name
  last_name=$(tail -n1 "${dir}/state/order.log" | awk '{print $3}')
  [ "${last_name}" = "GITHUB_APP_CLIENT_SECRET" ] \
    || fail "GITHUB_APP_CLIENT_SECRET was not the last Worker secret written (last was '${last_name}')"
}

if [ "${rc}" -ne 0 ]; then
  fail "expected create-apps.sh to succeed on the happy path, exited ${rc}"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -qF "stub-client-secret-value"; then
  fail "the fake client secret value leaked into create-apps.sh's output"
elif printf '%s' "${output}" | grep -qF "stub-webhook-secret-value"; then
  fail "the fake webhook secret value leaked into create-apps.sh's output"
elif printf '%s' "${output}" | grep -qF "PRIVATE KEY"; then
  fail "the fake private key leaked into create-apps.sh's output"
else
  before=${FAILURES}
  check_scenario1_content
  [ "${FAILURES}" -eq "${before}" ] && echo "ok: manifest matches ADR 0003, every stub received the right value, client secret written last"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 2: wrong Host, missing state and wrong state are ignored; a correct callback still finishes ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}")
read -r fake_github_port fake_github_pid <<< "$(start_fake_github "${dir}" "${fixture}")"
unset fixture

outfile="${dir}/scenario2.out"
run_create_apps "${dir}" "http://127.0.0.1:${fake_github_port}" 5000 1 --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!

if local_port=$(wait_for_create_apps_port "${outfile}") && wait_for_http_200 "http://127.0.0.1:${local_port}/"; then
  wrong_host_status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: attacker.example:${local_port}" "http://127.0.0.1:${local_port}/")
  [ "${wrong_host_status}" = "421" ] || fail "expected 421 for a wrong Host on '/', got ${wrong_host_status}"
  process_alive "${create_apps_pid}" || fail "the run died after a wrong-Host request to '/'"

  wrong_host_cb=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: attacker.example:${local_port}" "http://127.0.0.1:${local_port}/callback?code=x&state=y")
  [ "${wrong_host_cb}" = "421" ] || fail "expected 421 for a wrong Host on '/callback', got ${wrong_host_cb}"
  process_alive "${create_apps_pid}" || fail "the run died after a wrong-Host request to '/callback'"

  no_state_status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1:${local_port}" "http://127.0.0.1:${local_port}/callback")
  [ "${no_state_status}" = "400" ] || fail "expected 400 for /callback with no state, got ${no_state_status}"
  process_alive "${create_apps_pid}" || fail "the run died after a bare /callback request"

  wrong_state_status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1:${local_port}" "http://127.0.0.1:${local_port}/callback?code=x&state=deliberately-wrong")
  [ "${wrong_state_status}" = "400" ] || fail "expected 400 for /callback with the wrong state, got ${wrong_state_status}"
  process_alive "${create_apps_pid}" || fail "the run died after a wrong-state /callback request"

  page=$(curl -s -H "Host: 127.0.0.1:${local_port}" "http://127.0.0.1:${local_port}/")
  extracted_state=$(printf '%s' "${page}" | grep -oE 'state=[0-9a-f]+' | head -n1 | cut -d= -f2)
  if [ -z "${extracted_state}" ]; then
    fail "scenario 2: could not extract 'state' from the manifest page"
  else
    curl -s -o /dev/null -H "Host: 127.0.0.1:${local_port}" \
      "http://127.0.0.1:${local_port}/callback?code=fake-manifest-code&state=${extracted_state}"
  fi
else
  fail "scenario 2: create-apps.sh's local server never became reachable"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")

if [ "${rc}" -ne 0 ]; then
  fail "expected the run to still succeed after the noise above, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "set: GITHUB_APP_CLIENT_SECRET"; then
  fail "expected GITHUB_APP_CLIENT_SECRET to be set after the correct callback finally arrived"
  printf '%s\n' "${output}"
else
  echo "ok: wrong Host / missing state / wrong state are all ignored without killing the run"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 3: a conversion response with the wrong name or owner is rejected, breadcrumb updated ==="
for variant in name owner; do
  dir=$(new_scratch_repo)
  install_stub_wrangler "${dir}"
  install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
  if [ "${variant}" = name ]; then
    mismatched_slug="team-console-dev-imposter"
    fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}" "${mismatched_slug}")
  else
    mismatched_slug="team-console-dev"
    fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}" "team-console-dev" "attacker-login")
  fi
  read -r fake_github_port fake_github_pid <<< "$(start_fake_github "${dir}" "${fixture}")"
  unset fixture

  outfile="${dir}/scenario3-${variant}.out"
  run_create_apps "${dir}" "http://127.0.0.1:${fake_github_port}" 5000 1 --env dev --subdomain test-subdomain \
    > "${outfile}" 2>&1 &
  create_apps_pid=$!

  if local_port=$(wait_for_create_apps_port "${outfile}") && wait_for_http_200 "http://127.0.0.1:${local_port}/"; then
    page=$(curl -s "http://127.0.0.1:${local_port}/")
    extracted_state=$(printf '%s' "${page}" | grep -oE 'state=[0-9a-f]+' | head -n1 | cut -d= -f2)
    curl -s -o /dev/null "http://127.0.0.1:${local_port}/callback?code=fake&state=${extracted_state}"
  else
    fail "scenario 3 (${variant}): create-apps.sh's local server never became reachable"
  fi

  wait "${create_apps_pid}"
  rc=$?
  kill "${fake_github_pid}" >/dev/null 2>&1 || true
  wait "${fake_github_pid}" 2>/dev/null || true
  output=$(cat "${outfile}")

  if [ "${rc}" -eq 0 ]; then
    fail "scenario 3 (${variant}): expected the run to abort on a mismatched conversion response, it exited 0"
    printf '%s\n' "${output}"
  elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
    fail "scenario 3 (${variant}): a mismatched conversion response still resulted in a secret being set"
    printf '%s\n' "${output}"
  elif ! printf '%s' "${output}" | grep -qF "https://github.com/settings/apps/${mismatched_slug}"; then
    fail "scenario 3 (${variant}): expected the settings URL of the app GitHub actually created (${mismatched_slug})"
    printf '%s\n' "${output}"
  elif [ "$(cat "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_SLUG" 2>/dev/null)" != "${mismatched_slug}" ]; then
    fail "scenario 3 (${variant}): expected the breadcrumb to be updated to '${mismatched_slug}', got '$(cat "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_SLUG" 2>/dev/null)'"
  elif printf '%s' "${output}" | grep -qF -e "stub-client-secret-value" -e "stub-webhook-secret-value" -e "BEGIN PRIVATE KEY" -e "BEGIN RSA PRIVATE KEY"; then
    fail "scenario 3 (${variant}): a fake secret from the fixture leaked into the run's output"
    printf '%s\n' "${output}"
  else
    echo "ok: scenario 3 (${variant}) — mismatched conversion response rejected, breadcrumb points at the real app, no secret leaked"
  fi

  rm -rf "${dir}"
done

# ============================================================================================================
echo
echo "=== scenario 4: gh authenticated as someone other than the repository owner aborts before starting ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "someone-else"

output=$(run_create_apps "${dir}" "" 1000 "" --env dev --subdomain test-subdomain)
rc=$?

if [ "${rc}" -eq 0 ]; then
  fail "expected an owner/gh-login mismatch to abort, it exited 0"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "owner is '${DEFAULT_OWNER}'"; then
  fail "expected an explicit owner-mismatch error message"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "an owner mismatch still resulted in a secret being set"
  printf '%s\n' "${output}"
else
  echo "ok: an owner/gh-login mismatch aborts before any network call"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 5: an environment whose app already exists is skipped, no network needed ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
printf 'existing-secret' > "${dir}/state/dev.GITHUB_APP_CLIENT_SECRET"

output=$(run_create_apps "${dir}" "http://127.0.0.1:1" 1000 "" --env dev --subdomain test-subdomain)
rc=$?

if [ "${rc}" -ne 0 ]; then
  fail "expected create-apps.sh to exit 0 when skipping an existing app, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "already appears fully configured"; then
  fail "expected the 'already appears fully configured' skip message"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "an environment that should have been skipped still had secrets set"
  printf '%s\n' "${output}"
else
  echo "ok: an environment with an existing app is skipped without contacting the network"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 6: a half-created app (breadcrumb, no final secret) is reported; declining leaves it alone ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
printf 'team-console-dev-orphan' > "${dir}/state/gh-var.dev.CONSOLE_GITHUB_APP_SLUG"

output=$(printf 'n\n' | run_create_apps "${dir}" "http://127.0.0.1:1" 1000 "" --env dev --subdomain test-subdomain)
rc=$?

if [ "${rc}" -ne 0 ]; then
  fail "expected declining the half-created-app prompt to still exit 0, exited ${rc}"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "team-console-dev-orphan"; then
  fail "expected the half-created app's recorded slug to be reported"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "declining the half-created-app prompt still resulted in a secret being set"
  printf '%s\n' "${output}"
else
  echo "ok: a half-created app is reported by slug, and declining leaves everything untouched"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 7: CREATE_APPS_GITHUB_API_BASE is ignored without CREATE_APPS_TEST_MODE=1 (never calls the real API) ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}")
read -r fake_github_port fake_github_pid <<< "$(start_fake_github "${dir}" "${fixture}")"
unset fixture

outfile="${dir}/scenario7.out"
# CREATE_APPS_TEST_MODE is deliberately "" here — the whole point of this scenario. A short timeout and no
# /callback hit at all: the run must never be driven to the real api.github.com (SECURITY round 2) — the
# startup warning plus zero hits on the fake server already prove the override was ignored.
run_create_apps "${dir}" "http://127.0.0.1:${fake_github_port}" 1500 "" --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!

if ! local_port=$(wait_for_create_apps_port "${outfile}") || ! wait_for_http_200 "http://127.0.0.1:${local_port}/"; then
  fail "scenario 7: create-apps.sh's local server never became reachable"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")
hits=$(fake_github_hit_count "${dir}")

if [ "${hits}" != "0" ]; then
  fail "the fake local GitHub received ${hits} request(s) even though CREATE_APPS_TEST_MODE was not set"
  printf '%s\n' "${output}"
elif [ "${rc}" -eq 0 ]; then
  fail "expected the run to time out (nothing ever reaches /callback in this scenario), it exited 0"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -qi "ignored"; then
  fail "expected a warning that CREATE_APPS_GITHUB_API_BASE was ignored"
  printf '%s\n' "${output}"
else
  echo "ok: the override is ignored (warned, not used) without CREATE_APPS_TEST_MODE=1, and the real API is never touched"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 8: an invalid workers.dev subdomain is rejected before anything else runs ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"

output=$(run_create_apps "${dir}" "" 1000 "" --env dev --subdomain 'not a subdomain!')
rc=$?

if [ "${rc}" -eq 0 ]; then
  fail "expected an invalid subdomain to be rejected, it exited 0"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "doesn't look like a workers.dev subdomain"; then
  fail "expected a clear subdomain-validation error"
  printf '%s\n' "${output}"
else
  echo "ok: an invalid workers.dev subdomain is rejected up front"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 9: a wrangler put failure mid-way prints the recovery hint with the app's settings URL ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
fixture=$(make_fixture_json "${dir}" "team-console-dev" "${DEFAULT_OWNER}")
read -r fake_github_port fake_github_pid <<< "$(start_fake_github "${dir}" "${fixture}")"
unset fixture

outfile="${dir}/scenario9.out"
export WRANGLER_FAIL_PUT="WEBHOOK_SECRET"
run_create_apps "${dir}" "http://127.0.0.1:${fake_github_port}" 5000 1 --env dev --subdomain test-subdomain \
  > "${outfile}" 2>&1 &
create_apps_pid=$!
unset WRANGLER_FAIL_PUT

if local_port=$(wait_for_create_apps_port "${outfile}") && wait_for_http_200 "http://127.0.0.1:${local_port}/"; then
  page=$(curl -s "http://127.0.0.1:${local_port}/")
  extracted_state=$(printf '%s' "${page}" | grep -oE 'state=[0-9a-f]+' | head -n1 | cut -d= -f2)
  curl -s -o /dev/null "http://127.0.0.1:${local_port}/callback?code=fake&state=${extracted_state}"
else
  fail "scenario 9: create-apps.sh's local server never became reachable"
fi

wait "${create_apps_pid}"
rc=$?
kill "${fake_github_pid}" >/dev/null 2>&1 || true
wait "${fake_github_pid}" 2>/dev/null || true
output=$(cat "${outfile}")

if [ "${rc}" -eq 0 ]; then
  fail "scenario 9: expected the run to fail when a wrangler put fails, it exited 0"
  printf '%s\n' "${output}"
elif [ -f "${dir}/state/dev.GITHUB_APP_CLIENT_SECRET" ]; then
  fail "scenario 9: GITHUB_APP_CLIENT_SECRET must never be set when an earlier secret put failed"
elif ! printf '%s' "${output}" | grep -qF "https://github.com/settings/apps/team-console-dev"; then
  fail "scenario 9: expected the recovery hint's settings URL to be printed"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "Created as: 'team-console-dev'"; then
  fail "scenario 9: expected the recovery hint to name the app it already created"
  printf '%s\n' "${output}"
else
  echo "ok: a mid-way wrangler failure prints the recovery hint with the app's settings URL"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
echo "=== scenario 10: a breadcrumb lookup failure other than 'not found' aborts instead of proceeding ==="
dir=$(new_scratch_repo)
install_stub_wrangler "${dir}"
install_stub_gh "${dir}" "${DEFAULT_OWNER}" "${DEFAULT_OWNER}"
export GH_BREADCRUMB_FAIL=1
output=$(run_create_apps "${dir}" "" 1000 "" --env dev --subdomain test-subdomain)
rc=$?
unset GH_BREADCRUMB_FAIL

if [ "${rc}" -eq 0 ]; then
  fail "expected a breadcrumb-lookup failure to abort, it exited 0"
  printf '%s\n' "${output}"
elif ! printf '%s' "${output}" | grep -q "cannot tell whether a half-created app is pending"; then
  fail "expected the explicit 'cannot tell' abort message"
  printf '%s\n' "${output}"
elif printf '%s' "${output}" | grep -q "set: GITHUB_APP"; then
  fail "a breadcrumb-lookup failure still resulted in a secret being set"
  printf '%s\n' "${output}"
else
  echo "ok: a breadcrumb lookup failure other than 'not found' aborts, never read as 'no half-created app'"
fi

rm -rf "${dir}"

# ============================================================================================================
echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "ok: create-apps.sh stub scenarios passed"
  exit 0
else
  echo "${FAILURES} scenario(s) failed"
  exit 1
fi
