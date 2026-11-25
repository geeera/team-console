# workspace-checks

Vitest specs that guard the workspace as a whole: CI and deploy workflows, Worker configs, module boundaries, the
initial bundle, the Dockerfile's local-auth flags. No runtime code.

## Why `implicitDependencies: ["*"]`

The specs read other projects' files from disk at run time (`apps/api/wrangler.jsonc`, the console's `project.json`
and build output settings, `libs/worker/db` sources, ...). They do not import them, so Nx sees no dependency on those
projects. Without the wildcard:

- `nx affected -t test` would skip `workspace-checks` on a PR that changes only, say, `apps/api/wrangler.jsonc`, and
  the spec that guards that file would not run (#71);
- the `test` cache would be keyed on this project's own files alone, so a change elsewhere could replay a stale pass.

`"*"` makes every project a dependency: a change in any of them affects `workspace-checks` and invalidates its cache.
The specs are fast, so always running them is cheaper than keeping a hand-written list of projects in step with what
each spec happens to read.

The wildcard covers files that belong to a project. Root files that no project owns (`Dockerfile`, `.github/`,
`.product-team/`) affect nothing in the graph, so CI also runs `nx run workspace-checks:test` unconditionally on the
affected path (the "Workspace checks (always)" step in `.github/workflows/ci.yml`).

When adding a project, nothing needs updating here. Do not narrow the wildcard to a list.
