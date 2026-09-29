# syntax=docker/dockerfile:1
# Local and e2e target only (ADR 0001, decision 15): builds the workspace and runs the api Worker with
# `wrangler dev` and a local D1 on :8787, serving the app shell and /api/*. Production never runs this image —
# Workers deploy from source through wrangler in GitHub Actions (#7).
#
#   docker build -t team-console .
#   docker run --rm -p 8787:8787 team-console
#
ARG NODE_IMAGE=node:22-bookworm-slim

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

# --- runtime: wrangler only, the bundled Worker, the built assets, the config and the migrations ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production WRANGLER_SEND_METRICS=false CI=true
WORKDIR /app
COPY --from=build /app/package.json /tmp/workspace-package.json
RUN echo '{ "name": "team-console-runtime", "private": true }' > package.json \
  && wanted="$(node -p "require('/tmp/workspace-package.json').devDependencies.wrangler")" \
  && npm install --no-audit --no-fund --no-save --no-package-lock "wrangler@${wanted}" \
  && rm /tmp/workspace-package.json
COPY --from=build /app/dist/apps/console/browser ./dist/apps/console/browser
COPY --from=build /app/dist/apps/api ./dist/apps/api
COPY --from=build /app/apps/api/wrangler.jsonc ./apps/api/wrangler.jsonc
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
RUN chown -R node:node /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Fresh local D1 on every start, then the bundled Worker as built (`--no-bundle`). `--var AUTH_MODE:local` with
# `--var ENVIRONMENT:local` is the only place the local auth bypass is switched on (#8); `--ip 0.0.0.0` is for
# the container network and never for a deploy.
CMD ["sh", "-c", "npx wrangler d1 migrations apply team-console-dev --local --config apps/api/wrangler.jsonc --env dev && exec npx wrangler dev dist/apps/api/main.js --no-bundle --config apps/api/wrangler.jsonc --env dev --ip 0.0.0.0 --port 8787 --var ENVIRONMENT:local --var AUTH_MODE:local --var GITHUB_MOCK:true"]
