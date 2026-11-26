#!/usr/bin/env bash
# Prints the pinned image of one of security.yml's scanners, read from .github/scanners/<scanner>.Dockerfile (#48).
# The pin lives in a Dockerfile only because that is a file Dependabot's `docker` ecosystem updates; nothing builds
# it. This script is what keeps the pin exact: the file must be comments plus one
# `FROM <the scanner's own repository>:<x.y.z>@sha256:<64 hex>` line, so a floating tag, a missing digest, another
# image or a second instruction fails the job instead of running an unverified scanner. Bash with no dependencies:
# the scan jobs call it before anything is installed.
#
#   scanner-image.sh <gitleaks|semgrep> [directory, default: the repository's .github/scanners]
set -euo pipefail

usage='usage: scanner-image.sh <gitleaks|semgrep> [directory]'
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "${usage}" >&2
  exit 2
fi
scanner="$1"
directory="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/scanners}"

case "${scanner}" in
  gitleaks) reference='ghcr\.io/gitleaks/gitleaks:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}' ;;
  semgrep) reference='semgrep/semgrep:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}' ;;
  *)
    echo "${usage}" >&2
    exit 2
    ;;
esac

file="${directory}/${scanner}.Dockerfile"
if [ ! -f "${file}" ]; then
  echo "scanner-image: ${file} does not exist" >&2
  exit 1
fi

# Everything that is not a comment or a blank line; exactly one such line may exist.
instructions="$(grep -Ev '^[[:space:]]*(#.*)?$' "${file}" || true)"
if [[ ! "${instructions}" =~ ^FROM\ (${reference})$ ]]; then
  echo "scanner-image: ${file} must hold exactly one instruction, FROM <image>:<x.y.z>@sha256:<digest> of the ${scanner} image" >&2
  exit 1
fi
printf '%s\n' "${BASH_REMATCH[1]}"
