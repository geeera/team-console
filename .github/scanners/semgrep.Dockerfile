# The scanner of security.yml's `sast` job, pinned by exact version and digest (#48). Never built: it is a
# Dockerfile so that Dependabot's `docker` ecosystem bumps the tag and the digest together, in a reviewed PR whose
# own security run already uses the new version. tools/ci/scanner-image.sh reads the FROM line and refuses any
# other shape, so keep this file to comments and that one line.
FROM semgrep/semgrep:1.177.0@sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198
