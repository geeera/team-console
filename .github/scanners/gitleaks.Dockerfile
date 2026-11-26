# The scanner of security.yml's `secret-scan` job, pinned by exact version and digest (#48). Never built: it is a
# Dockerfile so that Dependabot's `docker` ecosystem bumps the tag and the digest together, in a reviewed PR whose
# own security run already uses the new version. tools/ci/scanner-image.sh reads the FROM line and refuses any
# other shape, so keep this file to comments and that one line.
FROM ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
