# syntax=docker/dockerfile:1
# The runner image (ADR 0008 decision 12 as the architect note on #468 settles it): one image for the runner and for
# each job's container. The one-file bundle, git, the Claude Code CLI pinned by version, the `job-exec` entrypoint
# and the managed settings at the CLI's managed path, all root-owned and read-only; jobs run as a non-root user on a
# read-only root (container backend). `release-runner.yml` builds, signs and publishes it on a `v*` tag.
#
#   docker build -f apps/runner/Dockerfile -t team-console-runner .
#   docker run --rm team-console-runner version
#
# node:22-bookworm-slim, pinned by the index digest (the root Dockerfile's; bump both together).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# --- build: the lockfile's exact versions, the npm package.json pins, then the bundle ---
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN wanted="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")" \
  && npm install --global --no-audit --no-fund "npm@${wanted}" \
  && npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY libs/shared ./libs/shared
COPY apps/runner ./apps/runner
# release-runner.yml passes the tag's version so `version` and `update` report it; empty keeps the dev label.
ARG TC_RUNNER_VERSION=
RUN npx tsc -p apps/runner/tsconfig.app.json --noEmit && node apps/runner/build.mjs

# --- cli: the Claude Code CLI at one exact version (bump it here only, with a test run of the image) ---
FROM ${NODE_IMAGE} AS cli
ARG CLAUDE_CODE_VERSION=2.1.325
RUN npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# --- runtime: Node, git, the CLI and the bundle; no npm cache, no build tools ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# /etc/claude-code is made here, not by the COPY below: a parent that COPY --chmod creates gets the file's mode, and a
# 0444 directory cannot be traversed, so the CLI would never see its managed settings.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 0755 /etc/claude-code \
  && groupadd --system job \
  && useradd --system --gid job --home-dir /home/job --create-home --shell /usr/sbin/nologin job
# Root-owned and read-only, so the job user can neither replace nor patch what it runs under.
COPY --from=cli --chown=root:root /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=build --chown=root:root --chmod=0555 /app/dist/apps/runner/team-console-runner.mjs /opt/team-console-runner/team-console-runner.mjs
COPY --from=build --chown=root:root --chmod=0555 /app/apps/runner/bin/job-exec /opt/team-console-runner/bin/job-exec
# Hooks off where no user or project file can override them (decision 8); the job never runs as root.
COPY --from=build --chown=root:root --chmod=0444 /app/apps/runner/managed-settings.json /etc/claude-code/managed-settings.json
RUN ln -s /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude
USER job
WORKDIR /home/job
ENTRYPOINT ["node", "/opt/team-console-runner/team-console-runner.mjs"]
CMD ["--help"]
