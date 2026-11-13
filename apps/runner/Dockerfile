# syntax=docker/dockerfile:1
# The runner image (ADR 0008 decision 12 as the architect note on #468 settles it): one image for the runner and,
# from 2-B-3, for each job's container. This is the skeleton of 2-B-1: the one-file bundle, run as a non-root user.
# 2-B-3 adds git, the pinned Claude Code CLI and the `job-exec` entrypoint; 2-B-5 builds, signs and publishes it.
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
RUN npx tsc -p apps/runner/tsconfig.app.json --noEmit && node apps/runner/build.mjs

# --- runtime: Node and the bundle only; no node_modules, no npm cache, no build tools ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN groupadd --system job \
  && useradd --system --gid job --home-dir /home/job --create-home --shell /usr/sbin/nologin job
# Root-owned and read-only, so the job user can neither replace nor patch the binary it runs under.
COPY --from=build --chown=root:root --chmod=0555 /app/dist/apps/runner/team-console-runner.mjs /opt/team-console-runner/team-console-runner.mjs
USER job
WORKDIR /home/job
ENTRYPOINT ["node", "/opt/team-console-runner/team-console-runner.mjs"]
CMD ["--help"]
