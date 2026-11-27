# Dependency notes

Notes on `package.json` entries whose version is pinned (or overridden) for a reason that
isn't obvious from the number alone. Keep each note next to the `overrides`/`devDependencies`
entry it explains and update it when the underlying condition changes.

## Storybook peer-dependency overrides (`@angular-devkit/build-angular`, `@angular/platform-browser-dynamic`)

`package.json`'s `overrides` pins:

```json
"@angular-devkit/build-angular": "22.2.5",
"@angular/platform-browser-dynamic": "22.2.4"
```

**Why they exist:** `@storybook/angular` (via `@analogjs/storybook-angular`) lists both packages as
required peer dependencies, not optional ones. Without the override, `npm ci` resolves whatever
version satisfies the peer range, which can drift from the Angular version the rest of the repo
uses (`22.2.4`/`22.2.5`) and break the Storybook build.

**Condition to remove them:** drop both override entries once a released version of
`@storybook/angular` (or `@analogjs/storybook-angular`) marks `@angular-devkit/build-angular` and
`@angular/platform-browser-dynamic` as optional peers, or stops requiring them outright. Checked
against `@storybook/angular` `10.6.7` (latest) and `11.0.0-beta.2` (next) on 2026-11-12 — both
still require them. Re-check with each new Storybook release; see geeera/team-console#524 for the
history.

## `smol-toml` security floor (`overrides.smol-toml`)

`package.json`'s `overrides` pins `"smol-toml": "1.9.1"`.

**Why it exists:** the only consumer is `nx`, and `nx` `23.2.1` pins `smol-toml` to exactly `1.6.1`.
The override came with the Nx workspace (#3, PR #32) at `1.7.1`, the first release patched for
GHSA-7w5x-hrqm-74c2; #986 raised it for the quadratic-time `parse()` (Dependabot alert #2, first
fixed in `1.9.0`). It is a security floor, not a compatibility pin.

**Condition to remove it:** drop the entry once the repo is on an `nx` release whose own `smol-toml`
pin is `>= 1.9.0` (`nx` `23.3.0` and later pin `1.9.0`).

## `minimatch` under `nx` and `@nx/devkit` (`overrides.nx.minimatch`, `overrides["@nx/devkit"].minimatch`)

`package.json`'s `overrides` pins `"minimatch": "11.0.9"` inside the `nx` and `@nx/devkit` scopes.

**Why they exist:** `minimatch` `>=7.0.0 <11.0.1` has a DoS through globparts amplification
(Dependabot alert #54, GHSA-g3hv-75wg-m249). `nx` and `@nx/devkit` `23.2.1` pin `minimatch` to
exactly `10.2.5`, and no `23.x` release fixes it (`23.3.3` still pins `10.2.5`); the first fixed Nx
is `24.x` (`11.0.8`), a major upgrade of the whole Nx toolchain. Nx calls only `minimatch()` and
`Minimatch`, which `11.x` keeps. The other `minimatch` consumers were fixed through their parents
instead (`eslint` `10.15.0`, `typescript-eslint` `8.73.0`, #986). The `3.1.5` copy under
`fork-ts-checker-webpack-plugin` is outside the vulnerable range.

**Condition to remove them:** drop both entries when the repo moves to `nx`/`@nx/devkit` `24.x`, or
to a `23.x` release that pins `minimatch` `>= 11.0.1`.
