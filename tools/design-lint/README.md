# design-lint

`node tools/design-lint/src/cli.ts` runs as the `lint` target of this project (so `nx run-many -t lint` and CI include it).
It fails on raw colours, lengths, durations and z-index values in console styles, on native date/time inputs (#307) and
on `display: grid` rules without a column template (#839).

## Grid baseline (`grid-columns-baseline.json`)

Rules that predate the grid check are listed per file with their hit count: 66 hits in 44 files (194 in 109 when the baseline was
recounted in #898; the sum of the JSON values is the number).

- A file may not have more hits than its baseline count; an unlisted file allows none.
- The baseline may only shrink. In CI the check reads the file at `NX_BASE` (the PR merge-base, or the previous commit
  on a push to `dev`) and fails when any file's count is higher than there. Locally `NX_BASE` is unset, so the check is
  skipped; run `NX_BASE=origin/dev node tools/design-lint/src/cli.ts` to try it.
- Fix a hit by setting the columns (`grid-template-columns: minmax(0, 1fr)`), or annotate a rule that really wants
  implicit columns with `/* grid-columns-ok: <why> */` inside it.
- After burning down hits, lower the numbers with `node tools/design-lint/src/cli.ts --write-grid-baseline`.
- Nested CSS is judged rule by rule: a rule that nests other rules is still checked on its own declarations.
