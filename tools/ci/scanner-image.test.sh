#!/usr/bin/env bash
# Tests of scanner-image.sh (#48), run by security.yml's `workflow-lint` job: the real pin files are accepted, and
# every way a pin could stop being exact (floating tag, no digest, another image, a second instruction) is refused.
# Deliberately not `set -e`: each exit code is checked explicitly so one failing assertion does not hide the next.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/scanner-image.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT
FAILURES=0
DIGEST="$(printf 'a%.0s' {1..64})"

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

# $1: test name, $2: scanner, $3: the Dockerfile's text, $4: the expected stdout
accepts() {
  local name="$1" scanner="$2" text="$3" expected="$4" output status
  printf '%s' "${text}" > "${SCRATCH}/${scanner}.Dockerfile"
  output="$(bash "${SCRIPT}" "${scanner}" "${SCRATCH}" 2>&1)"
  status=$?
  if [ "${status}" -ne 0 ] || [ "${output}" != "${expected}" ]; then
    fail "${name}: expected '${expected}', got exit ${status} and '${output}'"
  fi
}

# $1: test name, $2: scanner, $3: the Dockerfile's text
refuses() {
  local name="$1" scanner="$2" text="$3" output status
  printf '%s' "${text}" > "${SCRATCH}/${scanner}.Dockerfile"
  output="$(bash "${SCRIPT}" "${scanner}" "${SCRATCH}" 2>/dev/null)"
  status=$?
  if [ "${status}" -ne 1 ] || [ -n "${output}" ]; then
    fail "${name}: expected exit 1 and no output, got exit ${status} and '${output}'"
  fi
}

GITLEAKS="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:${DIGEST}"
SEMGREP="semgrep/semgrep:1.177.0@sha256:${DIGEST}"

accepts 'a gitleaks pin under comments' gitleaks $'# why\n\n  # indented comment\nFROM '"${GITLEAKS}"$'\n' "${GITLEAKS}"
accepts 'a semgrep pin without a trailing newline' semgrep "FROM ${SEMGREP}" "${SEMGREP}"
accepts 'a multi-digit version' semgrep $'FROM semgrep/semgrep:10.200.31@sha256:'"${DIGEST}"$'\n' "semgrep/semgrep:10.200.31@sha256:${DIGEST}"

refuses 'a tag without a digest' semgrep $'FROM semgrep/semgrep:1.177.0\n'
refuses 'a digest without a tag' semgrep $'FROM semgrep/semgrep@sha256:'"${DIGEST}"$'\n'
refuses 'a floating tag with a digest' semgrep $'FROM semgrep/semgrep:latest@sha256:'"${DIGEST}"$'\n'
refuses 'a partial version' semgrep $'FROM semgrep/semgrep:1.177@sha256:'"${DIGEST}"$'\n'
refuses 'a short digest' semgrep $'FROM semgrep/semgrep:1.177.0@sha256:abc123\n'
refuses 'an upper-case digest' semgrep $'FROM semgrep/semgrep:1.177.0@sha256:'"$(printf 'A%.0s' {1..64})"$'\n'
refuses 'another image under the scanner name' semgrep "FROM ${GITLEAKS}"$'\n'
refuses 'the same image from another registry' gitleaks $'FROM evil.example/gitleaks/gitleaks:v8.30.1@sha256:'"${DIGEST}"$'\n'
refuses 'a look-alike registry host' gitleaks $'FROM ghcrXio/gitleaks/gitleaks:v8.30.1@sha256:'"${DIGEST}"$'\n'
refuses 'a second FROM' semgrep "FROM ${SEMGREP}"$'\n'"FROM ${SEMGREP}"$'\n'
refuses 'an instruction after the pin' semgrep "FROM ${SEMGREP}"$'\nRUN true\n'
refuses 'a build stage name' semgrep "FROM ${SEMGREP} AS scanner"$'\n'
refuses 'a platform flag' semgrep "FROM --platform=linux/amd64 ${SEMGREP}"$'\n'
refuses 'a build argument in the reference' semgrep $'ARG TAG=1.177.0\nFROM semgrep/semgrep:${TAG}@sha256:'"${DIGEST}"$'\n'
refuses 'trailing text after the digest' semgrep "FROM ${SEMGREP} # comment"$'\n'
refuses 'CRLF line endings' semgrep "FROM ${SEMGREP}"$'\r\n'
refuses 'a file of comments only' semgrep $'# nothing pinned\n'
refuses 'an empty file' semgrep ''

rm -f "${SCRATCH}/gitleaks.Dockerfile"
output="$(bash "${SCRIPT}" gitleaks "${SCRATCH}" 2>/dev/null)"
status=$?
[ "${status}" -eq 1 ] && [ -z "${output}" ] || fail "a missing pin file: expected exit 1, got exit ${status} and '${output}'"

for arguments in '' 'trivy' 'semgrep a b'; do
  # shellcheck disable=SC2086 # the unquoted expansion is the argument list under test
  output="$(bash "${SCRIPT}" ${arguments} 2>/dev/null)"
  status=$?
  [ "${status}" -eq 2 ] && [ -z "${output}" ] || fail "arguments '${arguments}': expected exit 2, got exit ${status} and '${output}'"
done

# The committed pins, through the default directory: what the scan jobs actually run.
for scanner in gitleaks semgrep; do
  output="$(bash "${SCRIPT}" "${scanner}" 2>&1)"
  status=$?
  if [ "${status}" -ne 0 ]; then
    fail "the committed ${scanner} pin is refused: ${output}"
  else
    echo "ok: ${scanner} -> ${output}"
  fi
done

if [ "${FAILURES}" -ne 0 ]; then
  echo "${FAILURES} scanner-image test(s) failed" >&2
  exit 1
fi
echo 'scanner-image: all tests passed'
