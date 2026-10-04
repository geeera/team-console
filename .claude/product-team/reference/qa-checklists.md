# Review checklists

`qa` owns Acceptance, Accessibility and Polish; `security` owns Security; `reviewer` works from the project's
conventions and the owner's engineering baseline.

## Acceptance
- Every acceptance criterion implemented and covered by a test (e2e for user flows).
- No behaviour outside the issue's scope.

## Security — the `security` agent (PRs where `scripts/pr security-check` says so) — OWASP Top 10 / ASVS L1
- Access control on every new endpoint/query; no IDOR.
- Input validated server-side; parameterised queries; output encoded (XSS).
- Sessions/tokens: expiry, rotation, httpOnly/secure/sameSite cookies.
- No secrets in code, logs or client bundles; no PII in logs.
- SSRF / open redirect / file upload checks where relevant.
- New dependencies: maintained, licence compatible, no known critical CVE.

## Accessibility
- Keyboard: every action reachable, visible focus, no trap. Screen reader: names, roles, live regions.
- Contrast AA in both themes. Forms: labels, error association. Reduced motion honoured.
- A blocker = a core flow cannot be completed with keyboard or screen reader.

## Polish (wow)
- Empty states, loading skeletons, error states with a way forward.
- Micro-interactions and transitions use motion tokens; nothing janky — 60 fps on a mid-range phone profile.
- Copy is consistent and human (use `design:ux-copy`).

## Severity
- **Critical**: exploitable security flaw, data loss, core flow broken for everyone.
- **High**: security flaw with preconditions, core flow broken for a segment, a11y blocker.
- **Medium**: non-core flow broken, notable polish gap, performance regression.
- **Low**: cosmetic, minor copy.
