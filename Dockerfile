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
# `npm ci` tree keeps the exact lockfile versions; the check fails the build if an installed version drifts from it.
FROM deps AS runtime-deps
COPY <<'EOF' /tmp/runtime-package.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// A production dependency, so `npm ls` under the image's NODE_ENV=production still lists the tree.
const runtime = { name: pkg.name, private: true, dependencies: { wrangler: pkg.devDependencies.wrangler }, overrides: pkg.overrides };
writeFileSync('package.json', `${JSON.stringify(runtime, null, 2)}\n`);
EOF
COPY <<'EOF' /tmp/check-runtime-tree.mjs
import { existsSync, readFileSync } from 'node:fs';
const packagesOf = (path) => JSON.parse(readFileSync(path, 'utf8')).packages;
const locked = packagesOf('/tmp/workspace-lock.json');
const drift = [];
for (const [path, entry] of Object.entries(packagesOf('package-lock.json'))) {
  if (path === '') continue;
  const manifest = `${path}/package.json`;
  // Optional platform builds for other OSes/CPUs are in the lockfile but never on disk.
  if (!existsSync(manifest)) {
    if (!entry.optional) drift.push(`${path}: missing`);
    continue;
  }
  const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (installed !== locked[path]?.version) drift.push(`${path}: ${installed} != ${locked[path]?.version}`);
}
if (drift.length > 0) {
  console.error(`runtime tree drifts from package-lock.json:\n${drift.join('\n')}`);
  process.exit(1);
}
EOF
RUN cp package-lock.json /tmp/workspace-lock.json \
  && node /tmp/runtime-package.mjs \
  && npm prune --no-audit --no-fund \
  && node /tmp/check-runtime-tree.mjs \
  && npm ls sharp undici \
  && rm /tmp/workspace-lock.json /tmp/runtime-package.mjs /tmp/check-runtime-tree.mjs

# --- runtime: wrangler only, the bundled Worker, the built assets, the config and the migrations ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production WRANGLER_SEND_METRICS=false CI=true
WORKDIR /app
COPY --from=runtime-deps /app/package.json /app/package-lock.json ./
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/console/browser ./dist/apps/console/browser
COPY --from=build /app/dist/apps/api ./dist/apps/api
COPY --from=build /app/apps/api/wrangler.jsonc ./apps/api/wrangler.jsonc
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
RUN chown -R node:node /app
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
CMD ["sh", "-c", "npx wrangler d1 migrations apply team-console-dev --local --config apps/api/wrangler.jsonc --env dev && exec npx wrangler dev dist/apps/api/main.js --config apps/api/wrangler.jsonc --env dev --ip 0.0.0.0 --port 8787 --var ENVIRONMENT:local --var AUTH_MODE:local --var GITHUB_MOCK:true --var OWNER_GITHUB_LOGIN:geeera"]
