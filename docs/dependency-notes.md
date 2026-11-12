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
