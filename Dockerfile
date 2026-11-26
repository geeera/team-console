# syntax=docker/dockerfile:1
# Local and e2e target only (ADR 0001, decision 15): builds the workspace and runs the api Worker with
# `wrangler dev` and a local D1 on :8787, serving the app shell and /api/*. Production never runs this image —
# Workers deploy from source through wrangler in GitHub Actions (#7).
#
#   docker build -t team-console .
#   docker run --rm -p 127.0.0.1:8787:8787 team-console
#
# node:22-bookworm-slim, pinned by the index digest (verified on Docker Hub 2026-09-29); bump digest and tag together.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# --- deps: the lockfile is written by npm 10; use exactly the npm pinned in package.json (as CI does) ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN wanted="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")" \
  && npm install --global --no-audit --no-fund "npm@${wanted}" \
  && npm ci --no-audit --no-fund

# --- build: the Angular app plus both Workers (type-checked and bundled by wrangler, the same as a deploy) ---
FROM deps AS build
ENV NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false WRANGLER_SEND_METRICS=false CI=true
COPY . .
RUN npx nx run-many -t build

# --- runtime-deps: the lockfile's own tree pruned to wrangler (#263) ---
# A bare `npm install wrangler` re-resolved the tree and dropped the root `overrides` (sharp, undici). Pruning the
# `npm ci` tree keeps the exact lockfile versions: tools/runtime-image/runtime-package.mjs rewrites package.json to
# the runtime manifest (wrangler and the overrides), `npm prune` drops the rest, and the build fails unless the
# result is that tree (#819):
# tools/runtime-image/check-runtime-tree.mjs compares the workspace lockfile, the pruned lockfile and node_modules
# in both directions and refuses a comparison too small to be the wrangler tree. `npm ls --all` adds npm's verdict on
# the dependency edges: it exits non-zero on a missing or invalid dependency, but 0 on an extraneous package, which
# is why the script walks the disk itself.
# Last, npm's hidden lockfile goes (#1005): node_modules/.package-lock.json is npm's cache of the tree it has just
# been checked against, and nothing in the image runs npm.
FROM deps AS runtime-deps
COPY tools/runtime-image/runtime-package.mjs tools/runtime-image/check-runtime-tree.mjs /tmp/
RUN cp package-lock.json /tmp/workspace-lock.json \
  && node /tmp/runtime-package.mjs \
  && npm prune --no-audit --no-fund \
  && node /tmp/check-runtime-tree.mjs /tmp/workspace-lock.json /app \
  && npm ls --all > /dev/null \
  && npm ls sharp undici \
  && rm /tmp/workspace-lock.json /tmp/runtime-package.mjs /tmp/check-runtime-tree.mjs node_modules/.package-lock.json

# --- runtime: wrangler only, the bundled Worker, the built assets, the config and the migrations ---
# Everything under /app belongs to `node`. `COPY --chown` sets that as the files land; a `chown -R` afterwards
# rewrote every file into a second layer and made the image a third larger (#818).
# The pruned package-lock.json stays in `runtime-deps` (#819, #998): it is that stage's proof of the tree, and
# nothing here reads it or npm's hidden copy of it — wrangler is started from node_modules/.bin, without npm. CI's
# `runtime-image` job fails on any file in the image that this stage does not copy, and on either lockfile.
FROM ${NODE_IMAGE} AS runtime
# Nothing in the container calls out on wrangler's behalf (#1019). WRANGLER_SEND_METRICS=false stops the usage
# metrics; WRANGLER_SEND_ERROR_REPORTS=false the error report it would otherwise ask about on a TTY
# (`docker run -it`). WRANGLER_HIDE_BANNER=true skips the banner, and with it the npm registry query for a newer
# wrangler that every command makes before it prints the banner. wrangler 4.130 has no switch for that query
# itself: it still runs to word an error or a config warning, and CI's smoke fails if it ran on a clean start.
ENV NODE_ENV=production WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false WRANGLER_HIDE_BANNER=true CI=true
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node --from=runtime-deps /app/package.json ./
COPY --chown=node:node --from=runtime-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist/apps/console/browser ./dist/apps/console/browser
COPY --chown=node:node --from=build /app/dist/apps/api ./dist/apps/api
COPY --chown=node:node --from=build /app/apps/api/wrangler.jsonc ./apps/api/wrangler.jsonc
COPY --chown=node:node --from=build /app/apps/api/migrations ./apps/api/migrations
USER node

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Fresh local D1 on every start, then the Worker bundle as built. Not `--no-bundle`: with it wrangler 4.124's esbuild
# service stops soon after start and the runtime crashes on the next message it formats (#58; 5 crashes in 85 starts
# locally, none in 95 starts without the flag). `--var AUTH_MODE:local` with
# `--var ENVIRONMENT:local` is the only place the local auth bypass is switched on (#8); `--ip 0.0.0.0` is for
# the container network and never for a deploy. In mock mode the registry treats the mock GitHub's fixture owner as
# the connected account (#15, #59); `OWNER_GITHUB_LOGIN:geeera` is that owner, the login a connect would accept.
# wrangler is called by its path, never through `npx` (#1005): npx offers to fetch from the registry whatever it
# does not find in node_modules/.bin, and here a missing wrangler must be a container that does not start.
# Its path, the bundle's and the config's are absolute (#1013, #1019), so what runs does not depend on the directory
# the container starts in.
CMD ["sh", "-c", "/app/node_modules/.bin/wrangler d1 migrations apply team-console-dev --local --config /app/apps/api/wrangler.jsonc --env dev && exec /app/node_modules/.bin/wrangler dev /app/dist/apps/api/main.js --config /app/apps/api/wrangler.jsonc --env dev --ip 0.0.0.0 --port 8787 --var ENVIRONMENT:local --var AUTH_MODE:local --var GITHUB_MOCK:true --var OWNER_GITHUB_LOGIN:geeera"]
